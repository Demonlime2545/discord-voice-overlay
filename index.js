require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const multer = require('multer');
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');

const app = express();
const PORT = process.env.PORT || 3000;
const GUILD_ID = process.env.GUILD_ID;
const BOT_ID = '1414156880036761713'; // ID ของบอทที่ต้องการซ่อน

// ============================
// Static
// ============================
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/icons', express.static(path.join(__dirname, 'icons')));

// ============================
// Routes for HTML pages
// ============================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/setting', (req, res) => res.sendFile(path.join(__dirname, 'setting.html')));
app.get('/overlay', (req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
app.get('/add', (req, res) => res.sendFile(path.join(__dirname, 'add.html')));

// ============================
// Multer (upload handler)
// ============================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userId = req.query.userId || 'defaultUser';
        const uploadDir = path.join(__dirname, 'uploads', userId);
        fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const status = req.query.status || 'custom';
        const ext = path.extname(file.originalname) || '.png';
        cb(null, `${status}${ext}`);
    }
});
const upload = multer({ storage });

// ============================
// Upload avatar
// ============================
app.post('/upload-avatar', upload.single('avatar'), (req, res) => {
    const userId = req.query.userId || 'defaultUser';
    if (!req.file) return res.status(400).json({ error: 'no file' });

    const url = `/uploads/${userId}/${req.file.filename}?v=${Date.now()}`;
    const metaFile = path.join(__dirname, 'uploads', 'meta.json');
    let meta = {};
    if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile));

    if (!meta[userId]) meta[userId] = {};
    meta[userId][req.query.status || 'custom'] = { filename: req.file.filename, uploadedAt: Date.now() };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

    res.json({ url });
});

// ============================
// Get avatars
// ============================
app.get('/avatars/:userId', (req, res) => {
    const userId = req.params.userId;
    const statuses = ['speaking', 'not-speaking', 'mic-off', 'headphones'];
    const dir = path.join(__dirname, 'uploads', userId);
    const mapping = {};

    statuses.forEach(status => {
        let fileUrl = `/icons/${status}.png`;
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            const match = files.find(f => f.toLowerCase().startsWith(status.toLowerCase() + '.'));
            if (match) {
                const filepath = path.join(dir, match);
                const mtime = Math.round(fs.statSync(filepath).mtimeMs);
                fileUrl = `/uploads/${userId}/${match}?v=${mtime}`;
            }
        }
        mapping[status] = fileUrl;
    });

    res.json(mapping);
});

// ============================
// My uploads (for user only)
// ============================
app.get('/my-uploads', (req, res) => {
    const metaFile = path.join(__dirname, 'uploads', 'meta.json');
    if (!fs.existsSync(metaFile)) return res.json({ users: [] });

    const meta = JSON.parse(fs.readFileSync(metaFile));
    const users = [];

    Object.keys(meta).forEach(userId => {
        const avatars = {};
        let latest = 0;
        Object.keys(meta[userId]).forEach(status => {
            const info = meta[userId][status];
            avatars[status] = { url: `/uploads/${userId}/${info.filename}`, uploadedAt: info.uploadedAt };
            if (info.uploadedAt > latest) latest = info.uploadedAt;
        });
        users.push({ id: userId, username: `User ${userId}`, avatars, updatedAt: latest });
    });

    users.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ users });
});

// ============================
// WebSocket
// ============================
// const ws = new WebSocket('wss://discord-voice-overlay.onrender.com/ws');
function broadcast(data) {
    wss.clients.forEach(ws => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
    });
}

// ============================
// Discord bot setup
// ============================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildVoiceStates
    ]
});

async function ensureBotInVoice(channel) {
    let connection = getVoiceConnection(channel.guild.id);
    if (!connection) {
        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator
        });
        console.log(`[VOICE] Bot joined ${channel.name}`);
    }
    return connection;
}

const listeningGuilds = new Set();
function setupSpeakingListener(connection) {
    try {
        const guildId = connection.joinConfig?.guildId || connection.guildId;
        if (!guildId) return;

        // ลบ check listeningGuilds เพื่อให้ listener attach ทุกครั้ง
        const receiver = connection.receiver;

        // ลบ listener เก่า ถ้ามี
        receiver.speaking.removeAllListeners('start');
        receiver.speaking.removeAllListeners('end');

        // attach ใหม่
        receiver.speaking.on('start', userId => {
            if (userId === BOT_ID) return; // อย่า detect ตัวเอง
            broadcast({ id: userId, status: 'speaking' });
        });

        receiver.speaking.on('end', userId => {
            if (userId === BOT_ID) return;
            broadcast({ id: userId, status: 'not-speaking' });
        });

        console.log(`[VOICE] Listening speaking events for guild ${guildId}`);
    } catch (e) {
        console.error('setupSpeakingListener error', e);
    }
}


// ============================
// Track presence
// ============================
client.on('presenceUpdate', (oldPresence, newPresence) => {
    const userId = newPresence.userId;
    const status = newPresence.status || 'offline';
    broadcast({ id: userId, status });
});

// ============================
// Voice state
// ============================
client.on('voiceStateUpdate', async (oldState, newState) => {
    const user = newState.member?.user;
    if (!user || user.bot) return;

    if (!newState.channel) {
        broadcast({ id: user.id, status: 'headphones' });
        return;
    }
    if (newState.selfMute || newState.selfDeaf || newState.serverMute || newState.serverDeaf) {
        broadcast({ id: user.id, status: 'mic-off' });
        return;
    }

    try {
        // ให้ Bot join room ทุกครั้งที่คนเข้ามา
        const connection = await ensureBotInVoice(newState.channel);
        setupSpeakingListener(connection);
    } catch (e) { console.error(e); }
});

// ============================
// Slash commands
// ============================
const commands = [
    new SlashCommandBuilder().setName('join').setDescription('ให้บอทเข้าห้องเสียง'),
    new SlashCommandBuilder().setName('leave').setDescription('ให้บอทออกจากห้องเสียง')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Slash commands registered');
    } catch (err) { console.error(err); }
})();

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'join') {
        const channel = interaction.member?.voice?.channel;
        if (!channel) return interaction.reply('❌ คุณต้องอยู่ในห้องเสียงก่อน!');
        const connection = await ensureBotInVoice(channel);
        setupSpeakingListener(connection);
        interaction.reply(`✅ เข้าห้อง ${channel.name} แล้ว`);
    }
    if (interaction.commandName === 'leave') {
        const connection = getVoiceConnection(interaction.guild.id);
        if (!connection) return interaction.reply('❌ บอทยังไม่ได้อยู่ในห้องเสียง');
        connection.destroy();
        interaction.reply('👋 ออกจากห้องเสียงแล้ว');
    }
});

// ============================
// API: Only members in same VC as bot, hide bot itself
// ============================
app.get('/members', async (req, res) => {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return res.json({ members: [] });

        const channelId = req.query.channelId;
        let channel;

        if (channelId) {
            channel = await guild.channels.fetch(channelId).catch(() => null);
        } else {
            const botMember = guild.members.me;
            if (!botMember || !botMember.voice.channel) return res.json({ members: [] });
            channel = botMember.voice.channel;
        }

        if (!channel) return res.json({ members: [] });

        const members = channel.members
            .filter(m => m.id !== BOT_ID && !m.user.bot)
            .map(m => ({
                id: m.id,
                username: m.user.username,
                avatar: m.user.displayAvatarURL({ extension: "png", size: 128 }),
                bot: m.user.bot,
                status: m.presence ? m.presence.status : "offline"
            }));

        res.json({
            channelId: channel.id,
            channelName: channel.name,
            members
        });
    } catch (err) {
        console.error("Error in /members:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ============================
// API: All guild members
// ============================
app.get('/all-members', async (req, res) => {
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const members = await guild.members.fetch();

        const list = members.map(m => ({
            id: m.user.id,
            username: `${m.user.username}`,
            avatar: m.user.displayAvatarURL({ extension: 'png', size: 64 }),
            status: m.presence ? m.presence.status : "offline"
        }));

        res.json({ members: list });
    } catch (e) {
        console.error('Error /all-members:', e);
        res.status(500).json({ error: 'cannot fetch members' });
    }
});

// ============================
// Start server
// ============================
app.listen(PORT, () => console.log(`Web running on http://localhost:${PORT}`));

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    console.log(`✅ Members fetched: ${guild.memberCount}`);
});

client.login(process.env.TOKEN).catch(err => console.error(err));

// ============================
// Delete avatar
// ============================
app.delete('/delete-avatar', (req, res) => {
    const userId = req.query.userId || 'defaultUser';
    const status = req.query.status || 'custom';
    const dir = path.join(__dirname, 'uploads', userId);

    if (!fs.existsSync(dir)) return res.json({ success: false });

    const files = fs.readdirSync(dir);
    const match = files.find(f => f.toLowerCase().startsWith(status.toLowerCase() + '.'));
    if (match) {
        fs.unlinkSync(path.join(dir, match));
        // update meta.json
        const metaFile = path.join(__dirname, 'uploads', 'meta.json');
        if (fs.existsSync(metaFile)) {
            const meta = JSON.parse(fs.readFileSync(metaFile));
            if (meta[userId] && meta[userId][status]) delete meta[userId][status];
            fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
        }
        return res.json({ success: true });
    }

    res.json({ success: false });
});

