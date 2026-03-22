import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    delay // Helper bawaan Baileys buat nunggu
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        // Menghilangkan deprecated warning sesuai log lo sebelumnya
    });

    // 1. Handle Connection
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('🚀 CRM Bot is Online!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 2. Handle Messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Cek apakah pesan valid dan bukan dari diri sendiri
            if (!msg.message || msg.key.fromMe) continue;

            const jid = msg.key.remoteJid!;
            
            // --- FILTER: HANYA TERIMA PRIVATE CHAT ---
            // @s.whatsapp.net = Private
            // @g.us = Group
            if (jid.endsWith('@g.us')) {
                // console.log(`[SKIP] Pesan dari grup diabaikan.`);
                continue; 
            }

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || "";

            console.log(`[PRIVATE MSG] From: ${jid} | Text: ${text}`);

            // --- EFEK TYPING LOGIC ---
            // 1. Kirim status 'composing' (muncul tulisan Typing... di user)
            await sock.sendPresenceUpdate('composing', jid);
            
            // 2. Delay biar keliatan beneran ngetik (misal 2 detik)
            await delay(2000); 

            // 3. Matikan status typing (ubah jadi 'paused' atau biarkan hilang saat kirim pesan)
            await sock.sendPresenceUpdate('paused', jid);

            // --- RESPONSE LOGIC ---
            if (text.toLowerCase().includes('p')) {
                await sock.sendMessage(jid, { text: 'Halo! Ini admin CRM. Ada yang bisa dibantu?' });
            } else {
                await sock.sendMessage(jid, { text: 'Pesan diterima! Tim kami akan segera menghubungi Anda.' });
            }
        }
    });
}

startBot();