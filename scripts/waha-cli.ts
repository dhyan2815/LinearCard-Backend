import * as readline from 'readline';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode-terminal';

// Assuming running from apps/api or apps/api/scripts via ts-node
const envPath = path.resolve(__dirname, '../.env');

// Read existing .env
let envContent = '';
if (fs.existsSync(envPath)) {
  envContent = fs.readFileSync(envPath, 'utf8');
} else {
  console.log(`\n\x1b[31m[ERROR]\x1b[0m Could not find .env at ${envPath}`);
  process.exit(1);
}

const getEnv = (key: string) => {
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].replace(/['"]/g, '').trim() : '';
};

const WAHA_BASE_URL = getEnv('WAHA_BASE_URL');
if (!WAHA_BASE_URL) {
  console.log(`\n\x1b[31m[ERROR]\x1b[0m WAHA_BASE_URL is missing from .env`);
  process.exit(1);
}
const WAHA_API_KEY = getEnv('WAHA_API_KEY');
let currentSession = getEnv('WAHA_SESSION');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const log = (msg: string) => console.log(`\n\x1b[36m[INFO]\x1b[0m ${msg}`);
const err = (msg: string) => console.log(`\n\x1b[31m[ERROR]\x1b[0m ${msg}`);
const success = (msg: string) => console.log(`\n\x1b[32m[SUCCESS]\x1b[0m ${msg}`);

async function wahaRequest(method: string, endpoint: string, body?: any, retries = 2) {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  if (WAHA_API_KEY) headers['X-Api-Key'] = WAHA_API_KEY;

  const url = `${WAHA_BASE_URL.replace(/\/$/, '')}${endpoint}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res.json();
    } catch (error: any) {
      // Cloudflare occasionally returns an edge IP that's unreachable from this network;
      // a retry re-resolves DNS and usually lands on a working IP.
      const isNetworkError = !!error.cause;
      if (isNetworkError && attempt < retries) {
        log(`Network error, retrying (${attempt + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (isNetworkError) {
        throw new Error(`Network Error: ${error.cause.message || error.cause}`);
      }
      throw error;
    }
  }
}

function updateEnvSession(newSession: string) {
  if (envContent.includes('WAHA_SESSION=')) {
    envContent = envContent.replace(/^WAHA_SESSION=.*$/m, `WAHA_SESSION=${newSession}`);
  } else {
    envContent += `\nWAHA_SESSION=${newSession}\n`;
  }
  fs.writeFileSync(envPath, envContent, 'utf8');
  currentSession = newSession;
  success(`Updated .env WAHA_SESSION to: ${newSession}`);
}

async function showMenu() {
  console.log('\n==================================');
  console.log(`WAHA Session Manager`);
  console.log(`Server URL: ${WAHA_BASE_URL}`);
  console.log(`Active Session: ${currentSession || 'None'}`);
  console.log('==================================');
  console.log('1. [CREATE] Generate new session & authenticate');
  console.log('2. [STATUS] Check current session status');
  console.log('3. [QR] Re-fetch QR code for current session');
  console.log('4. [START] Start current session');
  console.log('5. [STOP] Stop current session');
  console.log('6. [DELETE] Delete current session');
  console.log('7. [LIST] List all WAHA sessions');
  console.log('8. Exit');
  console.log('==================================');
  
  rl.question('Select an option (1-8): ', async (answer) => {
    try {
      switch (answer.trim()) {
        case '1':
          await handleCreate();
          break;
        case '2':
          await handleStatus();
          break;
        case '3':
          await handleAuthQR();
          break;
        case '4':
          await handleStart();
          break;
        case '5':
          await handleStop();
          break;
        case '6':
          await handleDelete();
          break;
        case '7':
          await handleList();
          break;
        case '8':
          rl.close();
          process.exit(0);
        default:
          err('Invalid option.');
      }
    } catch (e: any) {
      err(e.message);
    }
    setTimeout(showMenu, 1000);
  });
}

async function handleCreate() {
  const newId = `dp_${crypto.randomBytes(4).toString('hex')}`;
  log(`Creating new session: ${newId}...`);
  await wahaRequest('POST', '/api/sessions/start', { name: newId });
  updateEnvSession(newId);
  
  log('Waiting 3 seconds for engine initialization...');
  setTimeout(async () => {
    await handleAuthQR();
  }, 3000);
}

async function handleStatus() {
  if (!currentSession) return err('No active session in .env');
  log(`Checking status for ${currentSession}...`);
  const data = await wahaRequest('GET', `/api/sessions/${currentSession}`);
  
  console.log('\n--- SESSION METADATA ---');
  console.log(`Name: ${data.name || currentSession}`);
  console.log(`Status: ${data.status}`);
  if (data.engine) {
    console.log(`Engine: ${JSON.stringify(data.engine, null, 2)}`);
  }
  if (data.me) {
    console.log(`Account (Me): ${JSON.stringify(data.me, null, 2)}`);
  }
  console.log('------------------------\n');
  
  if (data.status === 'FAILED') {
    err('Engine initialization failed. Please select Option 5 (Delete) and recreate.');
  } else {
    success(`Session is currently: ${data.status}`);
  }
}

async function handleAuthQR() {
  if (!currentSession) return err('No active session in .env');
  log(`Fetching QR code for ${currentSession}...`);
  try {
    const rawRes = await fetch(`${WAHA_BASE_URL}/api/${currentSession}/auth/qr?format=raw`, {
      headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY, 'Accept': 'application/json' } : { 'Accept': 'application/json' }
    });
    
    if (rawRes.ok) {
      const rawData = await rawRes.json();
      // WAHA returns { session: "...", url: "..." } for raw format
      const qrText = rawData.url || rawData.data || rawData.value || JSON.stringify(rawData);
      console.log('\n================ QR CODE ================');
      qrcode.generate(qrText, { small: true });
      console.log('=========================================\n');
      success('Scan this QR code with WhatsApp to authenticate.');
    } else {
      err('Failed to retrieve raw format. Outputting dashboard link instead.');
      log(`Open this in your browser: ${WAHA_BASE_URL}`);
    }
  } catch (e: any) {
    err(`Session not found or QR not ready. Status might be FAILED. Use Option 2 to check.`);
  }
}

async function handleStart() {
  if (!currentSession) return err('No active session in .env');
  log(`Starting existing session ${currentSession}...`);
  await wahaRequest('POST', '/api/sessions/start', { name: currentSession });
  success('Session started successfully.');
  
  log('Wait a few seconds, then check status (Option 2) or fetch QR (Option 3).');
}

async function handleStop() {
  if (!currentSession) return err('No active session in .env');
  log(`Stopping session ${currentSession}...`);
  await wahaRequest('POST', '/api/sessions/stop', { name: currentSession });
  success('Session stopped gracefully.');
}

async function handleDelete() {
  if (!currentSession) return err('No active session in .env');
  log(`Deleting session ${currentSession}...`);
  await wahaRequest('DELETE', `/api/sessions/${currentSession}`);
  success('Session successfully deleted from WAHA server.');
}

async function handleList() {
  log(`Fetching all sessions from WAHA server...`);
  try {
    const data = await wahaRequest('GET', '/api/sessions?all=true');
    if (Array.isArray(data) && data.length > 0) {
      console.log('\n--- ALL SESSIONS ---');
      data.forEach((s: any, index: number) => {
        const isCurrent = s.name === currentSession ? '(CURRENT)' : '';
        console.log(`${index + 1}. ${s.name} ${isCurrent} => STATUS: ${s.status}`);
      });
      console.log('--------------------\n');
    } else {
      success('No sessions found on the server.');
    }
  } catch (e: any) {
    err(`Failed to list sessions: ${e.message}`);
  }
}

// Start
showMenu();
