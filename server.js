const express = require('express');
const { google } = require('googleapis');
const speech = require('@google-cloud/speech');
const line = require('@line/bot-sdk');
const app = express();
app.use(express.json());

const SHEET_ID = process.env.SHEET_ID;
const LINE_TOKEN = process.env.LINE_TOKEN;
const STT_KEY = process.env.STT_KEY;
const VOICE_FOLDER_ID = process.env.VOICE_FOLDER_ID;

// Handle undefined GOOGLE_PRIVATE_KEY (main error from your log)
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;

if (!GOOGLE_PRIVATE_KEY || !GOOGLE_CLIENT_EMAIL) {
  console.error('Missing Google auth variables - Sheets/Drive/STT may fail');
}

const speechClient = new speech.SpeechClient({
  credentials: {
    private_key: GOOGLE_PRIVATE_KEY,
    client_email: GOOGLE_CLIENT_EMAIL
  }
});

const auth = new google.auth.JWT(GOOGLE_CLIENT_EMAIL, null, GOOGLE_PRIVATE_KEY, ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']);

const sheets = google.sheets({version: 'v4', auth});
const drive = google.drive({version: 'v3', auth});
const speechClient = new speech.SpeechClient({ credentials: { private_key: GOOGLE_PRIVATE_KEY, client_email: GOOGLE_CLIENT_EMAIL } });

app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  const events = req.body.events || [];
  events.forEach(async (event) => {
    if (event.type === 'message') {
      if (event.message.type === 'text') {
        const reply = await parseOrder(event.message.text);
        await replyLine(event.replyToken, reply);
      } else if (event.message.type === 'audio') {
        await processVoice(event.message.id, event.replyToken);
      }
    }
  });
});

async function parseOrder(text) {
  const match = text.match(/(?:([\u0E00-\u0E7F]+)\s+)?สั่ง\s*([\u0E00-\u0E7F]+)\s*(\d+)\s*([\u0E00-\u0E7F]+)?\s*(?:ส่งโดย\s*([\u0E00-\u0E7F]+))?/i);
  if (!match) return 'ไม่เข้าใจคำสั่งค่ะ';
  const customer = match[1] || 'ลูกค้าไม่ระบุ';
  const item = match[2];
  const qty = parseInt(match[3]);
  const unit = match[4] || 'ชิ้น';
  const deliver = match[5] || 'ไม่ระบุ';
  const stockData = await getStock(item, unit);
  if (stockData.stock < qty) return `สต็อก${item}ไม่พอ!`;
  const total = stockData.price * qty;
  const orderNo = await addOrder(item, qty, unit, customer, deliver, total);
  await updateStock(item, unit, stockData.stock - qty);
  return `${customer} ค่ะ!\n${item} ${qty}${unit} = ${total}฿\nส่งโดย ${deliver}\nรหัส: ${orderNo}`;
}

async function getStock(item, unit) {
  try {
    const range = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'สต็อก!A:E' });
    const rows = range.data.values || [];
    for (const row of rows) {
      if (row[0] === item && row[1] === unit) {
        return { stock: parseInt(row[3] || 0), price: parseInt(row[4] || 0) };
      }
    }
    return { stock: 0, price: 0 };
  } catch (e) {
    console.error('getStock error: ' + e);
    return { stock: 0, price: 0 };
  }
}

async function updateStock(item, unit, newStock) {
  try {
    const range = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'สต็อก!A:E' });
    const rows = range.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === item && rows[i][1] === unit) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `สต็อก!D${i+1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[newStock]] }
        });
        return;
      }
    }
  } catch (e) {
    console.error('updateStock error: ' + e);
  }
}

async function addOrder(item, qty, unit, customer, deliver, total) {
  try {
    const range = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'คำสั่งซื้อ!A:K' });
    const orderNo = range.data.values.length;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'คำสั่งซื้อ!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[orderNo, new Date(), customer, item, qty, unit, '', deliver, 'รอดำเนินการ', '', total]] }
    });
    return orderNo;
  } catch (e) {
    console.error('addOrder error: ' + e);
    return 0;
  }
}

async function processVoice(id, token) {
  try {
    const blob = await fetch(`https://api-data.line.me/v2/bot/message/${id}/content`, {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` }
    }).then(r => r.buffer());
    const transcript = await speechToText(blob);
    const reply = await parseOrder(transcript);
    await replyLine(token, `ได้ยิน: "${transcript}"\n${reply}`);
    // Save to Drive
    const file = await drive.files.create({
      resource: { name: `voice_${Date.now()}.m4a`, parents: [VOICE_FOLDER_ID] },
      media: { mimeType: 'audio/m4a', body: blob }
    }, { uploadType: 'multipart' });
  } catch (e) {
    await replyLine(token, 'STT ล้มเหลว ลองส่ง Text แทน');
  }
}

async function speechToText(blob) {
  const audioBytes = blob.toString('base64');

  const request = {
    config: {
      languageCode: 'th-TH',
      enableAutomaticPunctuation: true,
    },
    audio: {
      content: audioBytes
    }
  };

  const [response] = await speechClient.recognize(request);

  return response.results?.[0]?.alternatives?.[0]?.transcript || 'ไม่ชัดค่ะ';
}

async function replyLine(token, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken: token, messages: [{ type: 'text', text }] })
  });
}

app.listen(process.env.PORT || 3000, () => console.log('Bot running'));

