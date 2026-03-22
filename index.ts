// Taruh di paling atas sebelum import lain
const originalLog = console.log;
console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('Closing session')) return;
    originalLog(...args);
};

import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    delay 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import axios from 'axios';

// --- CONFIGURATION ---
const PYTHON_AI_URL = 'http://127.0.0.1:8000/api/chat';
const GRACE_PERIOD_MS = 3000; // Jeda 3 detik biar sync selesai
const MAX_MESSAGE_AGE_SEC = 60; // Jangan balas chat yang masuk > 1 menit lalu

let isBotReady = false;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true, // Kadang library butuh ini buat internal, meski kita handle manual
    });

    // 1. Connection Handler
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📢 Silakan scan QR Code untuk koneksi:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isBotReady = false;
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`❌ Koneksi Terputus (Status: ${statusCode}). Reconnect: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                console.log('🔄 Mencoba menyambung kembali dalam 5 detik...');
                setTimeout(() => startBot(), 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected! Menunggu sinkronisasi...');
            
            // Grace period: Kasih waktu Baileys buat "napas" sebelum terima beban chat
            setTimeout(() => {
                isBotReady = true;
                console.log('🚀 CRM Bot is TRULY Ready to handle messages!');
            }, GRACE_PERIOD_MS);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 2. Message Handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Skip jika bukan pesan baru atau bot belum benar-benar ready
        if (type !== 'notify' || !isBotReady) return;

        for (const msg of messages) {
            const jid = msg.key.remoteJid!;

            try {
                await sock.readMessages([msg.key]);
            } catch (err) {
                console.error('Failed to send read receipt:', err.message);
            }
            
            // SECURITY & FILTERING
            if (!msg.message || msg.key.fromMe) continue; // Jangan balas diri sendiri
            if (jid.endsWith('@g.us')) continue; // Skip grup (Private Only)

            // ANTI-FLOOD: Cek umur pesan
            const now = Math.floor(Date.now() / 1000);
            const msgTime = (msg.messageTimestamp as number);
            if (now - msgTime > MAX_MESSAGE_AGE_SEC) {
                console.log(`[SKIP] Pesan usang dari ${jid} (Delay: ${now - msgTime}s)`);
                continue;
            }

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || "";
            
            if (!text) continue;

            console.log(`[INCOMING] ${jid}: ${text}`);

            try {
                // --- STEP 1: TYPING EFFECT ---
                // Langsung nyalain biar user tau kita lagi proses
                await sock.sendPresenceUpdate('composing', jid);

                // --- STEP 2: HIT AI BRAIN (Python Flask) ---
                const aiResponse = await axios.post(PYTHON_AI_URL, {
                    jid: jid,
                    message: text
                }, { timeout: 25000 }); // Timeout 25 detik (toleransi LLM)

                const replyText = aiResponse.data.reply;

                // --- STEP 3: SEND RESPONSE ---
                await sock.sendPresenceUpdate('paused', jid);
                await sock.sendMessage(jid, { text: replyText });

            } catch (error: any) {
                console.error('⚠️ Interaction Error:', error.message);
                
                // Fallback jika AI service down atau socket error
                await sock.sendPresenceUpdate('paused', jid);
                
                // Opsional: Kirim pesan maintenance jika errornya spesifik ke AI Service
                if (error.code === 'ECONNREFUSED' || error.response) {
                    await sock.sendMessage(jid, { 
                        text: 'Waduh, sistem kami sedang berpikir keras. Boleh coba tanya lagi sebentar lagi, Kak?' 
                    });
                }
            }
        }
    });
}

// Global error handling biar proses gak mati konyol
process.on('uncaughtException', (err) => {
    console.error('🔥 CRITICAL ERROR:', err);
});

startBot();