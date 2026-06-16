import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';

console.log('📋 Variables de entorno cargadas:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '✅' : '❌ NO CARGADA');
console.log('SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? '✅' : '❌ NO CARGADA');
console.log('CHAKRA_API_KEY:', process.env.CHAKRA_API_KEY ? '✅' : '❌ NO CARGADA');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Clientes externos ────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY, // service_role key, no la anon
);

const CHAKRA_API_URL   = 'https://api.chakrahq.com';
const CHAKRA_PLUGIN_ID = process.env.CHAKRA_PLUGIN_ID;
const CHAKRA_API_KEY   = process.env.CHAKRA_API_KEY;
const CHAKRA_PHONE_ID  = process.env.CHAKRA_PHONE_NUMBER_ID;
const WA_API_VERSION   = process.env.WA_API_VERSION || 'v20.0';
const VERIFY_TOKEN     = process.env.WEBHOOK_VERIFY_TOKEN;

const chakraHeaders = () => ({
  Authorization: `Bearer ${CHAKRA_API_KEY}`,
  'Content-Type': 'application/json',
});

// ─── Helpers de Chakra ────────────────────────────────────────────────────────

function normalizePhone(raw = '') {
  let p = raw.replace(/\s+/g, '').replace(/^00/, '').replace(/^\+/, '');
  // Si es número mexicano de 10 dígitos, agregar 52
  if (p.length === 10 && !p.startsWith('52')) {
    p = '52' + p;
  }
  return p;
}

async function chakraSendSession(to, message) {
  const url = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${WA_API_VERSION}/${CHAKRA_PHONE_ID}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    to: normalizePhone(to),
    type: 'text',
    text: { body: message },
  }, { headers: chakraHeaders(), timeout: 15000 });
}

async function chakraSendTemplate(to, templateName, variables) {
  const url = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${WA_API_VERSION}/${CHAKRA_PHONE_ID}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    to: normalizePhone(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'es_MX' },
      components: variables.length > 0 ? [{
        type: 'body',
        parameters: variables.map(v => ({ type: 'text', text: String(v) })),
      }] : [],
    },
  }, { headers: chakraHeaders(), timeout: 15000 });
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const missing = ['CHAKRA_API_KEY', 'CHAKRA_PLUGIN_ID', 'CHAKRA_PHONE_NUMBER_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
    .filter(k => !process.env[k]);
  res.json({
    status: missing.length === 0 ? 'healthy' : 'misconfigured',
    missing,
    timestamp: new Date().toISOString(),
  });
});

// ─── Test cron (diagnóstico) ──────────────────────────────────────────────────
app.get('/test-cron', async (req, res) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const { data: citas, error } = await supabase
    .from('appointments')
    .select('id, date, time, status, barber_name, client_name, client_phone')
    .eq('date', tomorrowStr)
    .not('status', 'eq', 'cancelada');

  res.json({
    serverTime: new Date().toISOString(),
    tomorrowLooking: tomorrowStr,
    citasEncontradas: citas?.length ?? 0,
    citas: citas ?? [],
    error: error?.message ?? null,
  });
});

// ─── Envío de sesión ──────────────────────────────────────────────────────────

app.post('/chakra-send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ success: false, error: 'Faltan to o message' });
  try {
    await chakraSendSession(to, message);
    res.json({ success: true });
  } catch (error) {
    const status = error.response?.status ?? 500;
    const errMsg = error.response?.data?.message || error.message;
    console.error('❌ chakra-send:', status, errMsg);
    res.status(status).json({ success: false, error: errMsg });
  }
});

// ─── Envío de plantilla ───────────────────────────────────────────────────────

app.post('/chakra-send-template', async (req, res) => {
  const { to, templateName, variables = [] } = req.body;
  if (!to || !templateName) return res.status(400).json({ success: false, error: 'Faltan to o templateName' });
  try {
    await chakraSendTemplate(to, templateName, variables);
    res.json({ success: true });
  } catch (error) {
    const status = error.response?.status ?? 500;
    const errMsg = error.response?.data?.message || error.message;
    console.error('❌ chakra-send-template:', errMsg);
    res.status(status).json({ success: false, error: errMsg });
  }
});

// ─── Webhook Meta/WhatsApp ────────────────────────────────────────────────────
// GET: verificación inicial que pide Meta al configurar el webhook
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Token inválido');
});

// POST: mensajes y eventos entrantes de WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responder rápido a Meta, siempre

  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    // Ignorar eventos que no sean mensajes de texto
    const messages = value?.messages;
    if (!messages?.length) return;

    const msg  = messages[0];
    if (msg.type !== 'text') return;

    const from = msg.from;                        // número sin + ej: 522221234567
    const text = msg.text.body.trim().toLowerCase();

    console.log(`📩 WhatsApp de ${from}: "${text}"`);

    // ── Buscar cliente por teléfono ──────────────────────────────────────────
    // Buscamos tanto con +52 como sin él y con variantes de 10 dígitos
    const digits10 = from.replace(/^52/, '').slice(-10);
    const { data: clientRows } = await supabase
      .from('clients')
      .select('id, name, phone')
      .or(`phone.ilike.%${digits10}%`);

    const client = clientRows?.[0];
    if (!client) {
      console.warn(`⚠️ No se encontró cliente para ${from}`);
      return;
    }

    // ── Buscar su próxima cita pendiente ─────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const { data: citaRows } = await supabase
      .from('appointments')                       // ← ajusta el nombre de tu tabla
      .select('id, date, time, status, barber_name')
      .eq('client_id', client.id)
      .gte('date', today)
      .in('status', ['pendiente', 'confirmada'])
      .order('date', { ascending: true })
      .limit(1);

    const cita = citaRows?.[0];

    // ── Palabras clave de confirmación ───────────────────────────────────────
    const esConfirmacion = ['sí', 'si', 'confirmo', 'confirmar', '1', 'yes', 'ok', '✅'].some(k => text.includes(k));
    const esCancelacion  = ['no', 'cancelar', 'cancelo', 'cancel', '2', 'cancelación'].some(k => text.includes(k));

    if (!cita) {
      // No hay cita próxima — respuesta genérica
      await chakraSendSession(from, `Hola ${client.name.split(' ')[0]} 👋 No encontramos una cita próxima para ti. Para agendar escríbenos o llámanos.`);
      return;
    }

    if (esConfirmacion && cita.status !== 'confirmada') {
      // ── CONFIRMAR ────────────────────────────────────────────────────────
      await supabase
        .from('appointments')
        .update({ status: 'confirmada' })
        .eq('id', cita.id);

      await chakraSendSession(from,
        `✅ ¡Perfecto ${client.name.split(' ')[0]}! Tu cita del ${cita.date} a las ${cita.time ?? ''} con ${cita.barber_name ?? 'tu barbero'} queda *confirmada*. ¡Te esperamos! 💈`
      );
      console.log(`✅ Cita ${cita.id} confirmada para ${client.name}`);

    } else if (esCancelacion) {
      // ── CANCELAR ─────────────────────────────────────────────────────────
      await supabase
        .from('appointments')
        .update({ status: 'cancelada' })
        .eq('id', cita.id);

      await chakraSendSession(from,
        `❌ Entendido ${client.name.split(' ')[0]}, tu cita del ${cita.date} ha sido *cancelada*. Si quieres reagendar, escríbenos cuando gustes 🙌`
      );
      console.log(`❌ Cita ${cita.id} cancelada para ${client.name}`);

    } else {
      // Mensaje no reconocido — responder con opciones
      await chakraSendSession(from,
        `Hola ${client.name.split(' ')[0]} 👋 Tienes una cita el *${cita.date}* a las *${cita.time ?? ''}*.\n\nResponde:\n✅ *SÍ* para confirmar\n❌ *CANCELAR* para cancelar`
      );
    }
  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
  }
});

// Imagenes dentro de la conversación (ej: ticket de venta, encuesta post-servicio, etc.)

app.post('/chakra-send-image', async (req, res) => {
  try {
    const { to, image, caption } = req.body;

    if (!to || !image) {
      return res.status(400).json({ success: false, error: 'Faltan parámetros: to, image' });
    }

    // Validar que la imagen sea base64 válido
    if (!/^[A-Za-z0-9+/=]+$/.test(image)) {
      return res.status(400).json({ success: false, error: 'Imagen no válida' });
    }

    // Usar la API de Chakra para enviar imagen
    const response = await fetch('https://api.chakraapi.com/v1/send-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.CHAKRA_API_KEY,
      },
      body: JSON.stringify({
        instanceId: process.env.CHAKRA_INSTANCE_ID,
        phone: to,
        image: image,
        caption: caption || '🎫 Ticket de venta',
      }),
    });

    const data = await response.json();
    
    if (response.ok && data.success) {
      return res.json({ success: true });
    } else {
      return res.status(400).json({ 
        success: false, 
        error: data.error || 'Error al enviar la imagen' 
      });
    }
  } catch (error) {
    console.error('Error en chakra-send-image:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Cron: recordatorios 24h antes ───────────────────────────────────────────
// Se ejecuta todos los días a las 10:00 AM (hora del servidor en Render = UTC)
// Si tu barbería está en México (UTC-6), las 10am locales = 16:00 UTC
cron.schedule('0 15 * * *', async () => {
  console.log('⏰ Cron: enviando recordatorios 24h...');

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  try {
    // Obtener todas las citas de mañana que no estén canceladas
    const { data: citas, error } = await supabase
    .from('appointments')
    .select('id, date, time, status, barber_name, client_name, client_phone')
    .eq('date', tomorrowStr)
    .not('status', 'eq', 'cancelada');

    if (error) throw error;
    if (!citas?.length) {
      console.log('ℹ️ Sin citas para mañana');
      return;
    }

    console.log(`📅 ${citas.length} cita(s) para mañana — enviando recordatorios`);

    for (const cita of citas) {
    const phone = cita.client_phone;
    const name  = cita.client_name;
    if (!phone) { console.warn(`⚠️ Cita ${cita.id} sin teléfono`); continue; }

      try {
        await chakraSendTemplate(phone, 'barberia_recordatorio_24h', [
        name.split(' ')[0],
        cita.time ?? 'la hora agendada',
        cita.barber_name ?? 'tu barbero',
      ]);
        console.log(`✅ Recordatorio enviado a ${name} (${phone})`);

        // Pequeña pausa entre envíos para no saturar la API
        await new Promise(r => setTimeout(r, 1000));
      } catch (sendErr) {
        console.error(`❌ Error enviando a ${name}:`, sendErr.message);
      }
    }
  } catch (err) {
    console.error('❌ Error en cron recordatorios:', err.message);
  }
});

//test-reminder 
app.post('/test-send-reminder', async (req, res) => {
  const { phone, name, time, barber } = req.body;
  console.log('🧪 Test reminder - datos recibidos:', { phone, name, time, barber });
  try {
    await chakraSendTemplate(phone, 'barberia_recordatorio_24h', [
      name.split(' ')[0],
      time,
      barber,
    ]);
    console.log('✅ Template enviado correctamente');
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error detallado:', err.response?.data || err.message);
    res.status(500).json({ 
      success: false, 
      error: err.message,
      detail: err.response?.data ?? null  // ← esto nos dice qué rechazó Chakra
    });
  }
});

// ─── Inicio ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
  console.log(`🔑 API Key:   ${CHAKRA_API_KEY   ? '✅' : '❌ FALTA'}`);
  console.log(`📱 Phone ID:  ${CHAKRA_PHONE_ID  ? '✅' : '❌ FALTA CHAKRA_PHONE_NUMBER_ID'}`);
  console.log(`🗄️  Supabase:  ${process.env.SUPABASE_URL ? '✅' : '❌ FALTA SUPABASE_URL'}`);
  console.log(`🔔 Webhook:   ${process.env.WEBHOOK_VERIFY_TOKEN ? '✅ token personalizado' : `⚠️ usando token por defecto: ${VERIFY_TOKEN}`}`);
});