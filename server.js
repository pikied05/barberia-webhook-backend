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
  process.env.SUPABASE_SERVICE_KEY,
);

const CHAKRA_API_URL   = 'https://api.chakrahq.com';
const CHAKRA_PLUGIN_ID = process.env.CHAKRA_PLUGIN_ID;
const CHAKRA_API_KEY   = process.env.CHAKRA_API_KEY;
const CHAKRA_PHONE_ID  = process.env.CHAKRA_PHONE_NUMBER_ID;
const WA_API_VERSION   = process.env.WA_API_VERSION || 'v20.0';
const VERIFY_TOKEN     = process.env.WEBHOOK_VERIFY_TOKEN || 'imperium_verify_2024';

const chakraHeaders = () => ({
  Authorization: `Bearer ${CHAKRA_API_KEY}`,
  'Content-Type': 'application/json',
});

// ─── Helpers de Chakra ────────────────────────────────────────────────────────

function normalizePhone(raw = '') {
  let p = raw.replace(/\s+/g, '').replace(/^00/, '').replace(/^\+/, '');
  if (p.length === 10 && !p.startsWith('52')) p = '52' + p;
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

// ─── Lógica de disponibilidad ─────────────────────────────────────────────────

// Slots de 30 min de 10:00 a 19:30 (igual que tu agenda)
const ALL_SLOTS = [
  '10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30',
  '14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30',
  '18:00','18:30','19:00','19:30',
];

// Mapeo de días para comparar con el schedule del barbero
const DAY_MAP = { 0: 'Dom', 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb' };

function getNextDays(n = 5) {
  const days = [];
  const today = new Date();
  // Ajustar a zona horaria de México (UTC-6)
  today.setHours(today.getHours() - 6);
  let count = 0;
  let offset = 0;
  while (count < n) {
    offset++;
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    days.push(d);
    count++;
  }
  return days;
}

function formatDateMX(date) {
  const days = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
}

function toYMD(date) {
  return date.toISOString().slice(0, 10);
}

// Obtiene slots libres de un barbero en una fecha
async function getSlotsLibres(barberId, dateStr, duracionMinutos = 60) {
  const { data: citas } = await supabase
    .from('appointments')
    .select('time, end_time, duration_minutes')
    .eq('barber_id', barberId)
    .eq('date', dateStr)
    .not('status', 'eq', 'cancelada');

  const slotsOcupados = new Set();

  for (const cita of (citas || [])) {
    const durMin = cita.duration_minutes || 60;
    const [h, m] = cita.time.split(':').map(Number);
    const startTotal = h * 60 + m;
    // Marcar todos los slots que ocupa esta cita
    for (let i = 0; i < durMin; i += 30) {
      const slotTotal = startTotal + i;
      const slotH = String(Math.floor(slotTotal / 60)).padStart(2, '0');
      const slotM = String(slotTotal % 60).padStart(2, '0');
      slotsOcupados.add(`${slotH}:${slotM}`);
    }
  }

  // Filtrar slots donde cabe la duración del servicio sin chocar
  return ALL_SLOTS.filter(slot => {
    const [h, m] = slot.split(':').map(Number);
    const startTotal = h * 60 + m;
    // Verificar que todos los slots necesarios estén libres
    for (let i = 0; i < duracionMinutos; i += 30) {
      const needed = startTotal + i;
      const nh = String(Math.floor(needed / 60)).padStart(2, '0');
      const nm = String(needed % 60).padStart(2, '0');
      const neededSlot = `${nh}:${nm}`;
      if (slotsOcupados.has(neededSlot)) return false;
      if (!ALL_SLOTS.includes(neededSlot)) return false;
    }
    return true;
  });
}

// Construye el mensaje de disponibilidad para los próximos días
async function buildDisponibilidadMsg() {
  const { data: barberos } = await supabase
    .from('barbers')
    .select('id, name, schedule')
    .eq('active', true);

  if (!barberos?.length) return '😔 No hay barberos disponibles en este momento.';

  const nextDays = getNextDays(4); // próximos 4 días
  let msg = '✂️ *Horarios disponibles:*\n\n';
  let hayDisponibilidad = false;

  for (const day of nextDays) {
    const dayName = DAY_MAP[day.getDay()];
    const dateStr = toYMD(day);
    const barberosHoy = barberos.filter(b => {
      const schedule = Array.isArray(b.schedule) ? b.schedule : [];
      // Normalizar "Sáb" vs "Sab"
      return schedule.some(d => d.replace('á','a').replace('é','e') === dayName.replace('á','a').replace('é','e'));
    });

    if (!barberosHoy.length) continue;

    const lineasBarberos = [];
    for (const barbero of barberosHoy) {
      const slots = await getSlotsLibres(barbero.id, dateStr);
      if (!slots.length) continue;
      // Mostrar solo los primeros 4 slots disponibles
      const preview = slots.slice(0, 4).join(' · ');
      const mas = slots.length > 4 ? ` (+${slots.length - 4} más)` : '';
      lineasBarberos.push(`  👤 *${barbero.name}:* ${preview}${mas}`);
    }

    if (lineasBarberos.length) {
      hayDisponibilidad = true;
      msg += `📅 *${formatDateMX(day)}*\n${lineasBarberos.join('\n')}\n\n`;
    }
  }

  if (!hayDisponibilidad) {
    return '😔 No hay horarios disponibles en los próximos días. Escríbenos para buscar una fecha alternativa.';
  }

  msg += '➡️ Responde con el *nombre del barbero* y la *hora* que prefieras.\nEj: _Giovanni 15:00_';
  return msg;
}

// ─── Estado de conversación en memoria ───────────────────────────────────────
// Guarda el estado del flujo de agendado por número de teléfono
// { [phone]: { step, barberoId, barberoName, fecha, hora, clientName } }
const conversationState = {};

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

// ─── Envío de imagen ──────────────────────────────────────────────────────────

app.post('/chakra-send-image', async (req, res) => {
  try {
    const { to, image, caption } = req.body;
    if (!to || !image) return res.status(400).json({ success: false, error: 'Faltan parámetros: to, image' });
    if (!/^[A-Za-z0-9+/=]+$/.test(image)) return res.status(400).json({ success: false, error: 'Imagen no válida' });

    const response = await fetch('https://api.chakraapi.com/v1/send-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': process.env.CHAKRA_API_KEY },
      body: JSON.stringify({ instanceId: process.env.CHAKRA_INSTANCE_ID, phone: to, image, caption: caption || '🎫 Ticket de venta' }),
    });
    const data = await response.json();
    if (response.ok && data.success) return res.json({ success: true });
    return res.status(400).json({ success: false, error: data.error || 'Error al enviar la imagen' });
  } catch (error) {
    console.error('Error en chakra-send-image:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Webhook Meta/WhatsApp ────────────────────────────────────────────────────

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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const messages = value?.messages;
    if (!messages?.length) return;

    const msg = messages[0];
    if (msg.type !== 'text') return;

    const from = msg.from;
    const text = msg.text.body.trim();
    const textLower = text.toLowerCase();

    console.log(`📩 WhatsApp de ${from}: "${text}"`);

    // ── Buscar cliente ───────────────────────────────────────────────────────
    const digits10 = from.replace(/^52/, '').slice(-10);
    const { data: clientRows } = await supabase
      .from('clients')
      .select('id, name, phone')
      .or(`phone.ilike.%${digits10}%`);
    const client = clientRows?.[0];
    const firstName = client ? client.name.split(' ')[0] : 'amigo';

    // ══════════════════════════════════════════════════════════════════════════
    // FLUJO DE AGENDADO — tiene prioridad sobre todo lo demás
    // ══════════════════════════════════════════════════════════════════════════
    const state = conversationState[from];

    // Cancelar flujo en cualquier momento
    if (state && ['cancelar', 'salir', 'cancel', 'exit'].some(k => textLower.includes(k))) {
      delete conversationState[from];
      await chakraSendSession(from, `Ok ${firstName}, cancelé el proceso. Escríbeme *hola* cuando quieras agendar. 👍`);
      return;
    }

    // ── Paso 2: cliente eligió barbero y hora ────────────────────────────────
    // Formato esperado: "Giovanni 15:00" o "Giovanni 15:30"
    if (state?.step === 'esperando_seleccion') {
      const match = text.match(/([a-záéíóúñA-ZÁÉÍÓÚÑ\s]+)\s+(\d{1,2}:\d{2})/i);
      if (!match) {
        await chakraSendSession(from,
          `No entendí tu selección 😅\nEscríbeme así: _Nombre del barbero_ seguido de la hora.\nEj: *Giovanni 15:00*\n\nO escribe *cancelar* para salir.`
        );
        return;
      }

      const nombreBuscado = match[1].trim().toLowerCase();
      const horaSolicitada = match[2];

      // Buscar el barbero por nombre
      const { data: barberos } = await supabase
        .from('barbers')
        .select('id, name')
        .eq('active', true);

      const barbero = barberos?.find(b => b.name.toLowerCase().includes(nombreBuscado));
      if (!barbero) {
        await chakraSendSession(from, `No encontré al barbero "${match[1]}" 🤔\nRevisa el nombre e intenta de nuevo, o escribe *cancelar*.`);
        return;
      }

      // Verificar que el slot sigue libre
      const slotsLibres = await getSlotsLibres(barbero.id, state.fecha);
      const slotNormalizado = horaSolicitada.padStart(5, '0');
      if (!slotsLibres.includes(slotNormalizado)) {
        await chakraSendSession(from,
          `😔 Ese horario ya no está disponible con *${barbero.name}*.\nElige otra hora de las disponibles o escribe *hola* para ver los horarios actualizados.`
        );
        delete conversationState[from];
        return;
      }

      // Guardar selección y pedir confirmación
      conversationState[from] = {
        step: 'confirmando',
        barberoId: barbero.id,
        barberoName: barbero.name,
        fecha: state.fecha,
        fechaLabel: state.fechaLabel,
        hora: slotNormalizado,
        clientId: client?.id,
        clientName: client?.name || firstName,
        clientPhone: from,
      };

      await chakraSendSession(from,
        `📋 *Resumen de tu cita:*\n\n` +
        `👤 Barbero: *${barbero.name}*\n` +
        `📅 Fecha: *${state.fechaLabel}*\n` +
        `🕐 Hora: *${slotNormalizado}*\n\n` +
        `¿Confirmas?\n✅ Responde *SÍ* para agendar\n❌ Responde *NO* para cancelar`
      );
      return;
    }

    // ── Paso 3: confirmación final ───────────────────────────────────────────
    if (state?.step === 'confirmando') {
      const confirma = ['sí', 'si', 'yes', 'confirmo', 'ok', '1', '✅'].some(k => textLower.includes(k));
      const cancela  = ['no', 'cancelar', 'cancel', '2'].some(k => textLower.includes(k));

      if (confirma) {
        // Crear la cita en Supabase
        const { error } = await supabase.from('appointments').insert([{
          client_id:        state.clientId || null,
          client_name:      state.clientName,
          client_phone:     digits10,
          barber_id:        state.barberoId,
          barber_name:      state.barberoName,
          date:             state.fecha,
          time:             state.hora,
          status:           'pendiente',
          whatsapp_sent:    true,
          reminder_sent:    false,
          duration_minutes: 60,
          end_time:         (() => {
            const [h, m] = state.hora.split(':').map(Number);
            const end = h * 60 + m + 60;
            return `${String(Math.floor(end/60)).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`;
          })(),
          notes: 'Agendado por WhatsApp',
        }]);

        delete conversationState[from];

        if (error) {
          console.error('❌ Error creando cita desde WhatsApp:', error.message);
          await chakraSendSession(from, `Hubo un error al agendar tu cita 😔 Por favor llámanos o escríbenos directamente.`);
          return;
        }

        console.log(`✅ Cita agendada vía WhatsApp: ${state.clientName} con ${state.barberoName} el ${state.fecha} a las ${state.hora}`);
        await chakraSendSession(from,
          `✅ ¡Listo ${firstName}! Tu cita quedó agendada:\n\n` +
          `👤 *${state.barberoName}*\n` +
          `📅 *${state.fechaLabel}*\n` +
          `🕐 *${state.hora}*\n\n` +
          `Te esperamos en Imperium Caesar's Barber Club 💈\n_Si necesitas cancelar escríbenos con anticipación._`
        );
      } else if (cancela) {
        delete conversationState[from];
        await chakraSendSession(from, `Entendido, cancelé el proceso. Escríbeme *hola* cuando quieras agendar 👍`);
      } else {
        await chakraSendSession(from, `Responde *SÍ* para confirmar tu cita o *NO* para cancelar.`);
      }
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // RESPUESTAS AUTOMÁTICAS GENERALES
    // ══════════════════════════════════════════════════════════════════════════

    // ── Gracias ──────────────────────────────────────────────────────────────
    const esGracias = ['gracias', 'gracias!', 'muchas gracias', 'thank', 'thanks', '🙏', '👍'].some(k => textLower.includes(k));
    if (esGracias) {
      await chakraSendSession(from, `¡De nada ${firstName}! 😊 Con gusto. ¿Hay algo más en lo que te pueda ayudar?`);
      return;
    }

    // ── Hola / quiero agendar ─────────────────────────────────────────────────
    const esHola = ['hola', 'hello', 'hi', 'buenas', 'buenos', 'buen dia', 'buen día', 'hey'].some(k => textLower.includes(k));
    const esAgendar = ['agendar', 'cita', 'appointment', 'reservar', 'quiero', 'turno', 'hora'].some(k => textLower.includes(k));

    if (esHola || esAgendar) {
      // Calcular el próximo día disponible para el estado
      const nextDays = getNextDays(4);
      const { data: barberos } = await supabase.from('barbers').select('id, name, schedule').eq('active', true);
      let primerDiaDisponible = null;
      for (const day of nextDays) {
        const dayName = DAY_MAP[day.getDay()];
        const tieneBarbe = barberos?.some(b => {
          const schedule = Array.isArray(b.schedule) ? b.schedule : [];
          return schedule.some(d => d.replace('á','a').replace('é','e') === dayName.replace('á','a').replace('é','e'));
        });
        if (tieneBarbe) { primerDiaDisponible = day; break; }
      }

      if (primerDiaDisponible) {
        conversationState[from] = {
          step: 'esperando_seleccion',
          fecha: toYMD(primerDiaDisponible),
          fechaLabel: formatDateMX(primerDiaDisponible),
        };
      }

      const disponibilidadMsg = await buildDisponibilidadMsg();
      await chakraSendSession(from,
        `¡Hola ${firstName}! 👋 Bienvenido a *Imperium Caesar's Barber Club* 💈\n\n${disponibilidadMsg}`
      );
      return;
    }

    // ── Confirmación / cancelación de cita existente ──────────────────────────
    if (!client) {
      console.warn(`⚠️ No se encontró cliente para ${from}`);
      await chakraSendSession(from,
        `¡Hola! 👋 No encontramos tu número en nuestro sistema.\nEscribe *hola* para ver horarios disponibles o llámanos para más información. 💈`
      );
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: citaRows } = await supabase
      .from('appointments')
      .select('id, date, time, status, barber_name')
      .eq('client_id', client.id)
      .gte('date', today)
      .in('status', ['pendiente', 'confirmada'])
      .order('date', { ascending: true })
      .limit(1);
    const cita = citaRows?.[0];

    const esConfirmacion = ['sí', 'si', 'confirmo', 'confirmar', '1', 'yes', 'ok', '✅'].some(k => textLower.includes(k));
    const esCancelacion  = ['no', 'cancelar', 'cancelo', 'cancel', '2', 'cancelación'].some(k => textLower.includes(k));

    if (!cita) {
      await chakraSendSession(from,
        `Hola ${firstName} 👋 No tienes citas próximas.\n\nEscribe *hola* para ver horarios disponibles y agendar una cita. 💈`
      );
      return;
    }

    if (esConfirmacion && cita.status !== 'confirmada') {
      await supabase.from('appointments').update({ status: 'confirmada' }).eq('id', cita.id);
      await chakraSendSession(from,
        `✅ ¡Perfecto ${firstName}! Tu cita del *${cita.date}* a las *${cita.time}* con *${cita.barber_name ?? 'tu barbero'}* queda confirmada. ¡Te esperamos! 💈`
      );
      console.log(`✅ Cita ${cita.id} confirmada para ${client.name}`);
      return;
    }

    if (esCancelacion) {
      await supabase.from('appointments').update({ status: 'cancelada' }).eq('id', cita.id);
      await chakraSendSession(from,
        `❌ Entendido ${firstName}, tu cita del *${cita.date}* ha sido cancelada. Si quieres reagendar escribe *hola* cuando gustes 🙌`
      );
      console.log(`❌ Cita ${cita.id} cancelada para ${client.name}`);
      return;
    }

    // ── Mensaje no reconocido ─────────────────────────────────────────────────
    await chakraSendSession(from,
      `Hola ${firstName} 👋 Tienes una cita el *${cita.date}* a las *${cita.time}*.\n\nResponde:\n✅ *SÍ* para confirmar\n❌ *CANCELAR* para cancelar\n\nO escribe *hola* para ver horarios y agendar otra cita.`
    );

  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
  }
});

// ─── Test endpoints ───────────────────────────────────────────────────────────

app.get('/test-cron', async (req, res) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const { data: citas, error } = await supabase
    .from('appointments')
    .select('id, date, time, status, barber_name, client_name, client_phone, reminder_sent')
    .eq('date', tomorrowStr)
    .not('status', 'eq', 'cancelada');
  res.json({
    serverTime: new Date().toISOString(),
    tomorrowLooking: tomorrowStr,
    citasEncontradas: citas?.length ?? 0,
    pendientesDeEnvio: citas?.filter(c => !c.reminder_sent).length ?? 0,
    citas: citas ?? [],
    error: error?.message ?? null,
  });
});

app.post('/test-send-reminder', async (req, res) => {
  const { phone, variables } = req.body;
  console.log('🧪 Test reminder - phone:', phone, 'variables:', variables);
  try {
    await chakraSendTemplate(phone, 'barberia_recordatorio_24h', variables);
    res.json({ success: true, variablesUsadas: variables });
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message, detail: err.response?.data ?? null });
  }
});

app.get('/test-disponibilidad', async (req, res) => {
  const msg = await buildDisponibilidadMsg();
  res.json({ mensaje: msg });
});

// ─── Función compartida de recordatorios ─────────────────────────────────────

async function enviarRecordatorios(etiqueta = '') {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  console.log(`⏰ [${etiqueta}] Enviando recordatorios para ${tomorrowStr}...`);

  const { data: citas, error } = await supabase
    .from('appointments')
    .select('id, date, time, status, barber_name, client_name, client_phone')
    .eq('date', tomorrowStr)
    .eq('reminder_sent', false)
    .not('status', 'eq', 'cancelada');

  if (error) { console.error(`❌ [${etiqueta}] Error:`, error.message); return; }
  if (!citas?.length) { console.log(`ℹ️ [${etiqueta}] Sin citas nuevas para recordar`); return; }

  console.log(`📅 [${etiqueta}] ${citas.length} cita(s) sin recordatorio`);

  for (const cita of citas) {
    if (!cita.client_phone) { console.warn(`⚠️ Cita ${cita.id} sin teléfono`); continue; }
    try {
      await chakraSendTemplate(cita.client_phone, 'barberia_recordatorio_24h', [
        cita.client_name?.split(' ')[0] ?? 'Cliente',
        cita.time ?? 'la hora agendada',
      ]);
      await supabase.from('appointments').update({ reminder_sent: true }).eq('id', cita.id);
      console.log(`✅ Recordatorio enviado a ${cita.client_name} (${cita.client_phone})`);
      await new Promise(r => setTimeout(r, 1000));
    } catch (sendErr) {
      console.error(`❌ Error enviando a ${cita.client_name}:`, sendErr.message);
    }
  }
}

// ─── Cron matutino: 10:00 AM CDMX (16:00 UTC) ────────────────────────────────
cron.schedule('0 18 * * *', () => {
  console.log('🌅 Cron matutino disparado');
  enviarRecordatorios('MAÑANA');
});

// ─── Cron nocturno: 6:00 PM CDMX (00:00 UTC día siguiente) ──────────────────
cron.schedule('0 0 * * *', () => {
  console.log('🌙 Cron nocturno disparado');
  enviarRecordatorios('NOCHE');
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