const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

function loadContacts() {
    return new Promise((resolve, reject) => {
        const contacts = [];
        fs.createReadStream(config.csvFile)
            .pipe(csv())
            .on('data', (row) => {
                const number = (row.number || row.Number || '').toString().trim();
                const name = (row.name || row.Name || '').toString().trim();
                if (number && name) contacts.push({ number, name });
            })
            .on('end', () => resolve(contacts))
            .on('error', reject);
    });
}

function buildMessage(name) {
    return config.messageTemplate.replace(/\{name\}/g, name);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendMessages(client, contacts) {
    let photo = null;
    if (config.photoPath && fs.existsSync(config.photoPath)) {
        photo = MessageMedia.fromFilePath(path.resolve(config.photoPath));
        console.log(`Photo loaded: ${config.photoPath}`);
    } else if (config.photoPath) {
        console.warn(`Warning: photo not found at "${config.photoPath}" — sending text only.`);
    }

    console.log(`\nSending to ${contacts.length} contact(s)...\n`);

    for (let i = 0; i < contacts.length; i++) {
        const { number, name } = contacts[i];
        const chatId = `${number}@c.us`;
        const message = buildMessage(name);

        try {
            if (photo) {
                await client.sendMessage(chatId, photo, { caption: message });
            } else {
                await client.sendMessage(chatId, message);
            }
            console.log(`[${i + 1}/${contacts.length}] Sent to ${name} (${number})`);
        } catch (err) {
            console.error(`[${i + 1}/${contacts.length}] Failed for ${name} (${number}): ${err.message}`);
        }

        if (i < contacts.length - 1) {
            await sleep(config.delayBetweenMessages || 3000);
        }
    }

    console.log('\nDone.');
}

async function main() {
    const contacts = await loadContacts();
    if (contacts.length === 0) {
        console.error('No contacts found in CSV. Check your file and column names (number, name).');
        process.exit(1);
    }
    console.log(`Loaded ${contacts.length} contact(s) from ${config.csvFile}`);

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', (qr) => {
        console.log('\nScan this QR code with WhatsApp Business:\n');
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => console.log('\nAuthenticated. Session saved for future runs.'));

    client.on('auth_failure', (msg) => {
        console.error('Auth failed:', msg);
        process.exit(1);
    });

    client.on('ready', async () => {
        console.log('WhatsApp Business connected!\n');
        await sendMessages(client, contacts);
        await client.destroy();
        process.exit(0);
    });

    client.on('disconnected', (reason) => {
        console.log('Disconnected:', reason);
    });

    console.log('Starting WhatsApp Web client...');
    client.initialize();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
