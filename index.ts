// --- 1. INITIALIZATION & LOG FIX ---
const originalLog = console.log;
console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('Closing session')) return;
    originalLog(...args);
};

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import axios from 'axios';

// --- 2. CONFIGURATION ---
const PYTHON_AI_URL = 'http://127.0.0.1:8000/api/chat';
const GRACE_PERIOD_MS = 3000;
const MAX_MESSAGE_AGE_SEC = 60;
const WAIT_TIME_MS = 5000; // Jeda 5 detik buat nampung bubble chat

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mapping Key File (Tackle Path AI)
const FILE_MAP: Record<string, { type: 'image' | 'document', path: string, fileName?: string }> = {
    'banner_promo': { type: 'image', path: path.join(__dirname, 'assets', 'banner.jpg') },
    'proposal_erp': { type: 'document', path: path.join(__dirname, 'assets', 'proposal.pdf'), fileName: 'Proposal_Omniflow.pdf' },
};

// State Management
let isBotReady = false;
const messageBuffer = new Map<string, { timer: NodeJS.Timeout, content: string[] }>();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
    });

    // --- 3. CONNECTION HANDLER ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('📢 Silakan scan QR Code:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isBotReady = false;
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => startBot(), 5000);
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected!');
            setTimeout(() => { isBotReady = true; console.log('🚀 CRM Bot Ready!'); }, GRACE_PERIOD_MS);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- 4. MESSAGE HANDLER (WITH DEBOUNCE) ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || !isBotReady) return;

        for (const msg of messages) {
            const jid = msg.key.remoteJid!;
            if (!msg.message || msg.key.fromMe || jid.endsWith('@g.us')) continue;

            // Anti-flood check
            const now = Math.floor(Date.now() / 1000);
            if (now - (msg.messageTimestamp as number) > MAX_MESSAGE_AGE_SEC) continue;

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || "";

            if (!text) continue;

            // 4a. INSTANT COMMANDS (Tidak di-group)
            if (text.toLowerCase() === '/banner') {
                const imgPath = FILE_MAP['banner_promo'].path;
                if (existsSync(imgPath)) {
                    await sock.sendMessage(jid, { image: { url: imgPath }, caption: 'Ini Promo Omniflow! 🚀' });
                }
                continue;
            }

            // 4b. MESSAGE GROUPING LOGIC
            console.log(`[BUFFERING] ${jid}: ${text}`);
            
            let buffer = messageBuffer.get(jid);
            if (buffer) {
                clearTimeout(buffer.timer);
                buffer.content.push(text);
            } else {
                buffer = { timer: null as any, content: [text] };
            }

            // Status typing muncul selama nunggu
            await sock.sendPresenceUpdate('composing', jid);

            buffer.timer = setTimeout(async () => {
                const finalBuffer = messageBuffer.get(jid);
                if (!finalBuffer) return;

                const fullMessage = finalBuffer.content.join('\n');
                messageBuffer.delete(jid); // Clear buffer

                try {
                    console.log(`[PROCESS] Sending Grouped Message: \n${fullMessage}`);
                    
                    // HIT AI FLASK
                    const aiResponse = await axios.post(PYTHON_AI_URL, {
                        jid: jid,
                        message: fullMessage
                    }, { timeout: 30000 });

                    let replyText = aiResponse.data.reply;

                    // --- 5. AI FILE TACKLE (REGEX) ---
                    const fileMatch = replyText.match(/\[\[SEND_FILE:(.*?)\]\]/);
                    
                    if (fileMatch) {
                        const fileKey = fileMatch[1].trim();
                        const fileData = FILE_MAP[fileKey];
                        replyText = replyText.replace(fileMatch[0], "").trim();

                        // Kirim Teks
                        await sock.sendMessage(jid, { text: replyText });

                        // Kirim File jika ada
                        if (fileData && existsSync(fileData.path)) {
                            if (fileData.type === 'image') {
                                await sock.sendMessage(jid, { image: { url: fileData.path } });
                            } else {
                                await sock.sendMessage(jid, { 
                                    document: { url: fileData.path }, 
                                    mimetype: 'application/pdf', 
                                    fileName: fileData.fileName 
                                });
                            }
                        }
                    } else {
                        await sock.sendMessage(jid, { text: replyText });
                    }

                    await sock.sendPresenceUpdate('paused', jid);

                } catch (error: any) {
                    console.error('⚠️ Interaction Error:', error.message);
                    await sock.sendMessage(jid, { text: 'Waduh, otak AI gue lagi konslet. Coba bentar lagi ya!' });
                }
            }, WAIT_TIME_MS);

            messageBuffer.set(jid, buffer);
        }
    });
}

process.on('uncaughtException', (err) => console.error('🔥 CRITICAL:', err));
startBot();