// Overwrite /mnt/data/server.js with this content

require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const speech = require('@google-cloud/speech');
const fetch = require('node-fetch'); // node 18+ has global fetch, but safe to include
const line = require('@line/bot-sdk');

const app = express();
app.use(express.json());

// Env
const SHEET_ID = process.env.SHEET_ID;
const LINE_TOKEN = process.env.LINE_TOKEN;
const VOICE_FOLDER_ID = process.env.VOICE_FOLDER_ID;

// Load/normalize Google credentials
let GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || null;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || null;

// Normalize newline escapes if necessary
if (GOOGLE_PRIVATE_KEY && GOOGLE_PRIVATE_KEY.includes('\\n')) {
  GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
}

// Diagnostic logs (masked)
function mask(str, head = 10, tail = 10) {
  if (!str) return '<<missing>>';
  if (str.length <= head + tail) return str;
  return str.slice(0, head) + '...' + str.slice(-tail);
}
console.log('DIAG: GOOGLE_CLIENT_EMAIL =', mask(GOOGLE_CLIENT_EMAIL, 40, 0));
console.log('DIAG: GOOGLE_PRIVATE_KEY present?', !!GOOGLE_PRIVATE_KEY);
if (GOOGLE_PRIVATE_KEY) {
  console.log('DIAG: PRIVATE_KEY startsWith BEGIN?', GOOGLE_PRIVATE_KEY.trim().startsWith('-----BEGIN'));
  console.log('DIAG: PRIVATE_KEY length:', GOOGLE_PRIVATE_KEY.length);
}

// Validate required envs early
if (!SHEET_ID) console.warn('WARN: SHEET_ID missing');
if (!LINE_TOKEN) console.warn('WARN: LINE_TOKEN missing');
if (!GOOGLE_PRIVATE_KEY || !GOOGLE_CLIENT_EMAIL) {
  console.error('ERROR: Google service account credentials missing or malformed. Check GOOGLE_PRIVATE_KEY and GOOGLE_CLIENT_EMAIL in env.');
}

// Create single global speech client and google auth
let speechClient = null;
let sheets = null;
let drive = null;
try {
  if (GOOGLE_PRIVATE_KEY && GOOGLE_CLIENT_EMAIL) {
    speechClient = new speech.SpeechClient({
      credentials: {
        private_key: GOOGLE_PRIVATE_KEY,
        client_email: GOOGLE_CLIENT_EMAIL,
      }
    });

    const auth = new google.auth.JWT(
      GOOGLE_CLIENT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    );

    sheets = google.sheets({ version: 'v4', auth });
    drive = google.drive({ version: 'v3', auth });
  }
} catch (e) {
  console.error('INIT ERROR:', e);
}

// LINE client
const config = { channelAccessToken: LINE_TOKEN };
const client = new line.Client(config);

// Webhook
app.post('/webhook', line.middleware(config), async (req, res) => {
  res.status(200).send('OK');
  const events = req.body.events || [];
  for (const event of events) {
    try {
      if (event.type === 'message') {
        if (event.message.type === 'text') {
          const reply = await parseOrder(event.message.text);
          await replyLine(event.replyToken, reply);
        } else if (event.message.type === 'audio' || event.message.type === 'voice') {
          await processVoice(event.message.id, event.replyToken);
        }
      }
    } catch (err) {
      console.error('Event handling error:', err);
      try { await replyLine(event.replyToken, 'เกิดข้อผิดพลาดภายในระบบ'); } catch(e){console.error(e);}
    }
  }
});

// --- Order parsing
async function parseOrder(text) {
  const regex = /(?:([\u0E00-\u0E7F]+)\s+)?สั่ง\s*([\u0E00-\u0E7F]+)\s*(\d+)\s*([\u0E00-\u0E7F]+)?\s*(?:ส่งโดย\s*([\u0E00-\u0E7F]+))?/i;
  const match = text.match(regex);
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

// --- Sheets functions
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
    console.error('getStock error:', e);
    throw e;
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
          range: `สต็อก!D${i + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[newStock]] }
        });
        return;
      }
    }
  } catch (e) {
    console.error('updateStock error:', e);
  }
}

async function addOrder(item, qty, unit, customer, deliver, total) {
  try {
    const range = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'คำสั่งซื้อ!A:K' });
    const orderNo = (range.data.values || []).length + 1;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'คำสั่งซื้อ!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[orderNo, new Date().toISOString(), customer, item, qty, unit, '', deliver, 'รอดำเนินการ', '', total]] }
    });
    return orderNo;
  } catch (e) {
    console.error('addOrder error:', e);
    return 0;
  }
}

// --- Voice processing
async function processVoice(id, token) {
  try {
    const resp = await fetch(`https://api-data.line.me/v2/bot/message/${id}/content`, {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` }
    });
    const buffer = await resp.arrayBuffer();
    const blob = Buffer.from(buffer);
    const transcript = await speechToText(blob);
    const reply = await parseOrder(transcript);
    await replyLine(token, `ได้ยิน: "${transcript}"\n${reply}`);
    // save file to Drive if drive available
    if (drive && VOICE_FOLDER_ID) {
      await drive.files.create({
        resource: { name: `voice_${Date.now()}.m4a`, parents: [VOICE_FOLDER_ID] },
        media: { mimeType: 'audio/m4a', body: blob }
      }, { uploadType: 'multipart' });
    }
  } catch (e) {
    console.error('processVoice error:', e);
    await replyLine(token, 'STT ล้มเหลว ลองส่ง Text แทน');
  }
}

// --- STT (use global speechClient)
async function speechToText(blob) {
  if (!speechClient) throw new Error('speechClient not initialized');
  const audioBytes = blob.toString('base64');
  const request = {
    config: {
      languageCode: 'th-TH',
      enableAutomaticPunctuation: true
    },
    audio: { content: audioBytes }
  };
  const [response] = await speechClient.recognize(request);
  return response.results?.[0]?.alternatives?.[0]?.transcript || 'ไม่ชัด';
}

// --- reply helper
async function replyLine(token, text) {
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ replyToken: token, messages: [{ type: 'text', text }] })
    });
  } catch (e) { console.error('replyLine error:', e); }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Bot running on port', port));




