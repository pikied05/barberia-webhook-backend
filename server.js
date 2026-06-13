import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Configuración
const CHAKRA_API_URL = 'https://api.chakrahq.com';
const CHAKRA_PLUGIN_ID = process.env.CHAKRA_PLUGIN_ID;
const CHAKRA_API_KEY = process.env.CHAKRA_API_KEY;
const CHAKRA_PHONE_ID = process.env.CHAKRA_PHONE_NUMBER_ID;
const WA_API_VERSION = process.env.WA_API_VERSION || 'v20.0';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'mi_token_secreto_123';

const chakraHeaders = () => ({
  'Authorization': `Bearer ${CHAKRA_API_KEY}`,
  'Content-Type': 'application/json',
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      pluginId: !!CHAKRA_PLUGIN_ID,
      apiKey: !!CHAKRA_API_KEY,
      phoneId: !!CHAKRA_PHONE_ID
    }
  });
});

// ============================================
// WEBHOOK
// ============================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Verification failed' });
  }
});

app.post('/webhook', async (req, res) => {
  console.log('📨 Webhook recibido:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// ============================================
// API ENDPOINTS
// ============================================
app.post('/chakra-send', async (req, res) => {
  const { to, message } = req.body;
  
  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'Faltan campos' });
  }

  const cleanPhoneNumber = to.replace(/\s+/g, '').replace(/^\+/, '');
  
  const url = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${WA_API_VERSION}/${CHAKRA_PHONE_ID}/messages`;
  
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhoneNumber,
    type: 'text',
    text: { body: message },
  };

  try {
    const response = await axios.post(url, payload, { headers: chakraHeaders(), timeout: 15000 });
    res.json({ success: true, messageId: response.data?._data?.whatsappMessageId });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/chakra-send-template', async (req, res) => {
  const { to, templateName, variables = [] } = req.body;

  if (!to || !templateName) {
    return res.status(400).json({ success: false, error: 'Faltan campos' });
  }

  const cleanPhoneNumber = to.replace(/\s+/g, '').replace(/^\+/, '');
  const mapping = variables.map((value, index) => ({
    schemaPropertyName: String(index + 1),
    schemaPropertyValue: String(value || '')
  }));

  try {
    const url = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/phoneNumber/${cleanPhoneNumber}/send-template-message`;
    
    const payload = {
      whatsappPhoneNumberId: CHAKRA_PHONE_ID,
      templateName: templateName,
      mapping: mapping
    };

    const response = await axios.post(url, payload, { headers: chakraHeaders(), timeout: 15000 });
    res.json({ success: true, messageId: response.data?._data?.id });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// SERVIR FRONTEND (solo si dist existe)
// ============================================
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  console.log('✅ Sirviendo frontend desde', distPath);
  
  // Para cualquier ruta no API, enviar index.html
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/chakra') && !req.path.startsWith('/webhook') && req.path !== '/health') {
      res.sendFile(path.join(distPath, 'index.html'));
    }
  });
} else {
  console.log('⚠️ Carpeta dist no encontrada - solo endpoints API disponibles');
  app.get('/', (req, res) => {
    res.json({ message: 'API funcionando correctamente' });
  });
}

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});