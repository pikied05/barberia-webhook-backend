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
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

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

// Número(s) de WhatsApp del staff de la barbería a los que se les avisa cuando
// la automatización no pudo completar un agendado/reagendado por sí sola, para
// que lo registren manualmente. Puede ser una lista separada por comas.
const BARBERSHOP_ALERT_PHONES = (process.env.BARBERSHOP_ALERT_PHONES || '')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);

const chakraHeaders = () => ({
  Authorization: `Bearer ${CHAKRA_API_KEY}`,
  'Content-Type': 'application/json',
});

// ─── Idiomas aprobados por plantilla ─────────────────────────────────────────
const TEMPLATE_LANGUAGE_CANDIDATES = {
  barberia_ticket_venta:      ['es_MX'],
  barberia_recordatorio_24h:  ['es_MX'],
  barberia_confirmacion_cita: ['es_MX'],
  barberia_encuesta_servicio: ['es_MX'],
  clientes_en_riesgo_cupon:            ['es_MX'],
  cliente_en_riesgo_reenganche:        ['en', 'en_GB', 'en_US', 'es_MX'],
  clientes_en_riesgo_recordatorio_suave: ['es_MX'],
  clientes_en_riesgo_encuesta_regreso:   ['es_MX'],
  alerta_staff_manual:        ['es_MX'],
};

// ─── Plantillas que respetan el opt-out de mensajes automatizados ────────────
// Si un cliente tiene no_automated_messages = true en Supabase, estas plantillas
// NO se le envían (recordatorio, confirmación y reenganche). Cupón/ticket/encuesta
// no están incluidos porque no fueron parte de lo solicitado.
const AUTOMATED_TEMPLATES = [
  'barberia_recordatorio_24h',
  'barberia_confirmacion_cita',
  'cliente_en_riesgo_reenganche',
];

// Verifica si un cliente (por teléfono) optó por no recibir mensajes automatizados
async function clienteOptoPorNoMensajes(phone) {
  if (!phone) return false;
  const digits10 = normalizePhone(phone).slice(-10);
  const { data, error } = await supabase
    .from('clients')
    .select('no_automated_messages')
    .ilike('phone', `%${digits10}%`);
  if (error) {
    console.error('⚠️ Error verificando opt-out de mensajes:', error.message);
    return false; // ante la duda, no bloquear el envío por un error de lectura
  }
  return (data || []).some(c => c.no_automated_messages === true);
}

// ─── Helpers de Chakra ────────────────────────────────────────────────────────

function normalizePhone(raw = '') {
  let p = raw.replace(/\s+/g, '').replace(/^00/, '').replace(/^\+/, '');
  if (p.startsWith('521') && p.length === 13) p = '52' + p.slice(3);
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

// Avisa al WhatsApp de la barbería cuando la automatización no pudo completar
// un agendado/reagendado por sí sola (error de base de datos, etc.), para que
// el equipo lo registre manualmente. Nunca debe tronar el flujo del cliente:
// si el envío de la alerta falla, solo se loguea.
async function alertarEquipoManual({ cliente, fechaHora, barbero, detalle }) {
  const resumenLog = `Cliente: ${cliente} | Fecha/hora: ${fechaHora} | Barbero: ${barbero} | Detalle: ${detalle}`;
  console.error(`🚨 ALERTA MANUAL: ${resumenLog}`);
  if (!BARBERSHOP_ALERT_PHONES.length) {
    console.warn('⚠️ BARBERSHOP_ALERT_PHONES no configurado — no se pudo notificar al staff.');
    return;
  }
  for (const numero of BARBERSHOP_ALERT_PHONES) {
    try {
      await chakraSendTemplate(numero, 'alerta_staff_manual', [
        cliente || 'No identificado',
        fechaHora || 'No especificada',
        barbero || 'No especificado',
      ]);
    } catch (err) {
      console.error(`❌ No se pudo enviar alerta (plantilla) a ${numero}:`, err.response?.data ?? err.message);
      // Respaldo: intenta mensaje de sesión por si hay una ventana de 24h abierta.
      try {
        await chakraSendSession(numero, `🚨 *Atención requerida*\n\nCliente: ${cliente}\nFecha/hora: ${fechaHora}\nBarbero: ${barbero}\nDetalle: ${detalle}`);
      } catch (err2) {
        console.error(`❌ Tampoco se pudo enviar como sesión a ${numero}:`, err2.response?.data ?? err2.message);
      }
    }
  }
}

// Coordenadas de Imperium Caesar's Barber Club
const BARBERSHOP_LOCATION = {
  latitude: 18.984230560513783,
  longitude: -98.29344295798947,
  name: "Imperium Caesar's Barber Club",
  address: 'Blvd. de las Cascadas 299-Loc 12, Lomas de Angelópolis, 72865 Puebla, Pue.',
};

async function chakraSendLocation(to) {
  const url = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${WA_API_VERSION}/${CHAKRA_PHONE_ID}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    to: normalizePhone(to),
    type: 'location',
    location: {
      latitude: BARBERSHOP_LOCATION.latitude,
      longitude: BARBERSHOP_LOCATION.longitude,
      name: BARBERSHOP_LOCATION.name,
      address: BARBERSHOP_LOCATION.address,
    },
  }, { headers: chakraHeaders(), timeout: 15000 });
}

function esErrorDeIdioma(error) {
  const dataStr = JSON.stringify(error.response?.data ?? '');
  return dataStr.includes('132001') || error.response?.data?.error?.code === 132001;
}

async function chakraSendTemplate(to, templateName, variables) {
  const url = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${WA_API_VERSION}/${CHAKRA_PHONE_ID}/messages`;
  const candidatos = TEMPLATE_LANGUAGE_CANDIDATES[templateName] || ['es_MX'];

  let ultimoError;
  for (const lang of candidatos) {
    try {
      const resp = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: normalizePhone(to),
        type: 'template',
        template: {
          name: templateName,
          language: { code: lang },
          components: variables.length > 0 ? [{
            type: 'body',
            parameters: variables.map(v => ({ type: 'text', text: String(v) })),
          }] : [],
        },
      }, { headers: chakraHeaders(), timeout: 15000 });

      const wamid = resp.data?.messages?.[0]?.id;
      console.log(`✅ Plantilla "${templateName}" aceptada (idioma "${lang}") — wamid: ${wamid}`);
      return;
    } catch (error) {
      ultimoError = error;
      if (!esErrorDeIdioma(error)) throw error;
      console.warn(`⚠️ Idioma "${lang}" no válido para "${templateName}", probando siguiente...`);
    }
  }
  throw ultimoError;
}

// ─── Lógica de disponibilidad ─────────────────────────────────────────────────

const ALL_SLOTS = [
  '10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30',
  '14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30',
  '18:00','18:30','19:00','19:30',
];

// Sábado y domingo el negocio cierra a las 5:00 pm. Dejamos como último slot
// reservable las 16:00, para que una cita de 60 min termine justo a las 17:00
// y no se pase de la hora de cierre de fin de semana.
const WEEKEND_SLOTS = [
  '10:00','10:30','11:00','11:30','12:00','12:30',
  '13:00','13:30','14:00','14:30','15:00','15:30','16:00',
];

function esFinDeSemana(fechaODateStr) {
  const d = fechaODateStr instanceof Date ? fechaODateStr : new Date(`${fechaODateStr}T12:00:00`);
  const dia = d.getDay();
  return dia === 0 || dia === 6; // Domingo o Sábado
}

function getSlotsDelDia(fechaODateStr) {
  return esFinDeSemana(fechaODateStr) ? WEEKEND_SLOTS : ALL_SLOTS;
}

function getCierreDelDia(fechaODateStr) {
  const slots = getSlotsDelDia(fechaODateStr);
  const [h, m] = slots[slots.length - 1].split(':').map(Number);
  return h * 60 + m + 30;
}

// Rango de horario a mostrar en mensajes de error, según el día (para no decir
// "10:00 – 19:30" en sábado/domingo cuando el negocio cierra a las 17:00).
function getHorarioLabel(fechaODateStr) {
  const slots = getSlotsDelDia(fechaODateStr);
  return `${slots[0]} – ${slots[slots.length - 1]}`;
}

const DAY_MAP = { 0: 'Dom', 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb' };

function getNextDays(n = 5) {
  const days = [];
  const today = new Date();
  today.setHours(today.getHours() - 6);
  let count = 0, offset = 0;
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
  const days   = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
}

function toYMD(date) {
  return date.toISOString().slice(0, 10);
}

function formatFechaCorta(ymd) {
  if (!ymd || ymd.length < 10) return ymd || '';
  const [, m, d] = ymd.split('-');
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return `${parseInt(d, 10)} de ${meses[parseInt(m, 10) - 1] || ymd}`;
}

async function getSlotsLibres(barberId, dateStr, filtroHoraActual = null) {
  const { data: citas } = await supabase
    .from('appointments')
    .select('time, duration_minutes')
    .eq('barber_id', barberId)
    .eq('date', dateStr)
    .not('status', 'eq', 'cancelada');

  const slotsOcupados = new Set();
  for (const cita of (citas || [])) {
    const durMin = cita.duration_minutes || 60;
    const [h, m] = cita.time.split(':').map(Number);
    const startTotal = h * 60 + m;
    for (let i = 0; i < durMin; i += 30) {
      const slotTotal = startTotal + i;
      const slotH = String(Math.floor(slotTotal / 60)).padStart(2, '0');
      const slotM = String(slotTotal % 60).padStart(2, '0');
      slotsOcupados.add(`${slotH}:${slotM}`);
    }
  }

  const slotsDelDia   = getSlotsDelDia(dateStr);
  const cierreMinutos = getCierreDelDia(dateStr);

  return slotsDelDia.filter(slot => {
    if (filtroHoraActual !== null) {
      const [h, m] = slot.split(':').map(Number);
      const slotMinutos = h * 60 + m;
      if (slotMinutos <= filtroHoraActual) return false;
    }
    
    const [h, m] = slot.split(':').map(Number);
    const startTotal = h * 60 + m;
    for (let i = 0; i < 60; i += 30) {
      const needed = startTotal + i;
      if (needed > cierreMinutos) return false; // se pasaría de la hora de cierre
      const nh = String(Math.floor(needed / 60)).padStart(2, '0');
      const nm = String(needed % 60).padStart(2, '0');
      const neededSlot = `${nh}:${nm}`;
      if (slotsOcupados.has(neededSlot)) return false;
    }
    return true;
  });
}

function splitSlots(slots) {
  const manana = slots.filter(s => parseInt(s.split(':')[0]) < 14);
  const tarde  = slots.filter(s => parseInt(s.split(':')[0]) >= 14);
  return [...manana.slice(0, 2), ...tarde.slice(0, 2)];
}

// ─── Construye el mensaje de lista de precios (reutilizable) ────────────────

async function buildPreciosMsg(includeCTA = true) {
  const { data: servicios, error } = await supabase
    .from('services')
    .select('name, price, duration, category')
    .eq('active', true)
    .order('category', { ascending: true });

  let mensajePrecios = `💰 *Lista de Precios - Imperium Caesar's Barber Club* 💈\n\n`;

  if (error || !servicios || servicios.length === 0) {
    mensajePrecios += 
      `✂️ *Corte de Cabello*: $350\n` +
      `🧔 *Arreglo de Barba*: $250\n` +
      `💈 *Corte + Barba*: $550\n` +
      `🪒 *Afeitado Clásico*: $300\n` +
      `✨ *Tratamiento Especial*: $400\n\n` +
      `📞 Para más información, llámanos al (55) XXXX-XXXX`;
  } else {
    const categorias = {};
    for (const servicio of servicios) {
      const cat = servicio.category || 'Otros';
      if (!categorias[cat]) categorias[cat] = [];
      categorias[cat].push(servicio);
    }

    for (const [categoria, items] of Object.entries(categorias)) {
      mensajePrecios += `*${categoria}:*\n`;
      for (const item of items) {
        mensajePrecios += `  • ${item.name}: *$${item.price}*\n`;
      }
      mensajePrecios += '\n';
    }

    mensajePrecios += `💳 Aceptamos efectivo y tarjetas.\n`;
    if (includeCTA) {
      mensajePrecios +=
        `📅 Recuerda que puedes agendar tu cita escribiendo *hola*.\n\n` +
        `¿Te gustaría reservar un espacio?`;
    }
  }

  return mensajePrecios;
}

async function buildDisponibilidadMsg() {
  const { data: barberos } = await supabase
    .from('barbers').select('id, name, schedule').eq('active', true);

  if (!barberos?.length) return '😔 No hay barberos disponibles en este momento.';

  const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const todayStr = nowMX.toISOString().slice(0, 10);
  const dayName  = DAY_MAP[nowMX.getDay()];
  const horaActual = nowMX.getHours() * 60 + nowMX.getMinutes();

  const barberosHoy = barberos.filter(b => {
    const schedule = Array.isArray(b.schedule) ? b.schedule : [];
    return schedule.some(d =>
      d.replace('á','a').replace('é','e') === dayName.replace('á','a').replace('é','e')
    );
  });

  let diaFinal = nowMX;
  let dateStrFinal = todayStr;
  let barberosFinales = barberosHoy;

  if (!barberosHoy.length) {
    const nextDays = getNextDays(4);
    for (const day of nextDays) {
      const dn = DAY_MAP[day.getDay()];
      const tieneBarbe = barberos.some(b => {
        const schedule = Array.isArray(b.schedule) ? b.schedule : [];
        return schedule.some(d => d.replace('á','a').replace('é','e') === dn.replace('á','a').replace('é','e'));
      });
      if (tieneBarbe) {
        diaFinal = day;
        dateStrFinal = toYMD(day);
        barberosFinales = barberos.filter(b => {
          const schedule = Array.isArray(b.schedule) ? b.schedule : [];
          return schedule.some(d => d.replace('á','a').replace('é','e') === dn.replace('á','a').replace('é','e'));
        });
        break;
      }
    }
  }

  let msg = `✂️ *Horarios disponibles — ${formatDateMX(diaFinal)}:*\n\n`;
  let hayDisponibilidad = false;

  const esHoy = dateStrFinal === todayStr;

  for (const barbero of barberosFinales) {
    let slots = await getSlotsLibres(barbero.id, dateStrFinal, esHoy ? horaActual : null);
    if (!slots.length) continue;

    const seleccionados = splitSlots(slots);
    if (!seleccionados.length) continue;

    hayDisponibilidad = true;
    const preview = seleccionados.join(' · ');
    msg += `👤 *${barbero.name}:* ${preview}\n`;
  }

  if (!hayDisponibilidad) {
    // ✅ Sin slots → buscar siguiente día disponible automáticamente
    const nextDaysList = getNextDays(7);
    for (const day of nextDaysList) {
      const dn = DAY_MAP[day.getDay()];
      const barberosDay = barberos.filter(b => {
        const schedule = Array.isArray(b.schedule) ? b.schedule : [];
        return schedule.some(d =>
          d.replace('á','a').replace('é','e') === dn.replace('á','a').replace('é','e')
        );
      });
      if (!barberosDay.length) continue;
      const dateStrDay = toYMD(day);
      let msgFallback = `✂️ *Horarios disponibles — ${formatDateMX(day)}:*\n\n`;
      let haySlots = false;
      for (const barbero of barberosDay) {
        const slots = await getSlotsLibres(barbero.id, dateStrDay, null);
        const sel = splitSlots(slots);
        if (!sel.length) continue;
        haySlots = true;
        msgFallback += `👤 *${barbero.name}:* ${sel.join(' · ')}\n`;
      }
      if (haySlots) {
        msgFallback += `\n➡️ Responde con el *nombre del barbero* y la *hora*.\nEj: _Giovanni 10:00_\n\n💡 O solo manda la *hora* y te asignamos un barbero disponible.`;
        return msgFallback;
      }
    }
    return '😔 No hay horarios disponibles en los próximos días. Escríbenos para ayudarte. 💈';
  }

  msg += `
➡️ Responde con el *nombre del barbero* y la *hora*.
Ej: _Giovanni 15:00_

💡 ¿No conoces a nuestros barberos? Solo manda la *hora* y nosotros te asignamos uno disponible.
Ej: _15:00_ o _3 pm_`;
  return msg;
}

// ─── Estado de conversación en memoria ───────────────────────────────────────
const conversationState = {};

// ─── Deduplicación de webhooks ────────────────────────────────────────────────
// Meta puede reintentar la entrega del mismo webhook (ej. si el servidor tardó
// en responder 200 OK), lo que provocaba que el mismo mensaje del cliente se
// procesara dos veces y se enviaran respuestas duplicadas/contradictorias.
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 500;
function yaFueProcesado(wamid) {
  if (!wamid) return false;
  if (processedMessageIds.has(wamid)) return true;
  processedMessageIds.add(wamid);
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const primero = processedMessageIds.values().next().value;
    processedMessageIds.delete(primero);
  }
  return false;
}

// ─── Helpers de búsqueda ──────────────────────────────────────────────────────

async function getClienteYCita(from) {
  const digits10 = from.replace(/^52/, '').slice(-10);
  const { data: clientRows } = await supabase
    .from('clients').select('id, name, phone').or(`phone.ilike.%${digits10}%`);
  const client = clientRows?.[0] || null;

  let cita = null;
  if (client) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: citaRows } = await supabase
      .from('appointments')
      .select('id, date, time, status, barber_name, barber_id, service_name, service_id')
      .eq('client_id', client.id)
      .gte('date', today)
      .in('status', ['pendiente', 'confirmada'])
      .order('date', { ascending: true })
      .limit(1);
    cita = citaRows?.[0] || null;
  }

  return { client, cita };
}

// Busca la cita cancelada más reciente del cliente (de ayer en adelante), para
// poder ofrecer "reagendar" justo después de una cancelación sin que el cliente
// tenga que volver a escribir todo desde cero.
async function getCitaCanceladaReciente(from) {
  const digits10 = from.replace(/^52/, '').slice(-10);
  const { data: clientRows } = await supabase
    .from('clients').select('id, name, phone').or(`phone.ilike.%${digits10}%`);
  const client = clientRows?.[0] || null;
  if (!client) return { client: null, cita: null };

  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  const ayerStr = ayer.toISOString().slice(0, 10);

  const { data: citaRows } = await supabase
    .from('appointments')
    .select('id, date, time, status, barber_name, barber_id, service_name, service_id')
    .eq('client_id', client.id)
    .eq('status', 'cancelada')
    .gte('date', ayerStr)
    .order('id', { ascending: false })
    .limit(1);

  return { client, cita: citaRows?.[0] || null };
}

async function getEncuestaPendiente(from) {
  const digits10 = from.replace(/^52/, '').slice(-10);
  const limiteFecha = new Date();
  limiteFecha.setDate(limiteFecha.getDate() - 3);
  const { data } = await supabase
    .from('appointments')
    .select('id, date')
    .ilike('client_phone', `%${digits10}%`)
    .eq('survey_sent', true)
    .is('survey_responded_at', null)
    .gte('survey_sent_at', limiteFecha.toISOString())
    .order('date', { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const missing = ['CHAKRA_API_KEY', 'CHAKRA_PLUGIN_ID', 'CHAKRA_PHONE_NUMBER_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
    .filter(k => !process.env[k]);
  res.json({ status: missing.length === 0 ? 'healthy' : 'misconfigured', missing, timestamp: new Date().toISOString() });
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

  if (AUTOMATED_TEMPLATES.includes(templateName)) {
    const optoPorNoMensajes = await clienteOptoPorNoMensajes(to);
    if (optoPorNoMensajes) {
      console.log(`🚫 Mensaje automatizado "${templateName}" bloqueado para ${to} — el cliente desactivó los mensajes automatizados`);
      return res.json({ success: true, skipped: true, reason: 'cliente_opto_por_no_mensajes' });
    }
  }

  try {
    await chakraSendTemplate(to, templateName, variables);
    res.json({ success: true });
  } catch (error) {
    const status = error.response?.status ?? 500;
    const metaError = error.response?.data?.error;
    const errMsg = metaError?.message || error.response?.data?._errors?.join('; ') || error.response?.data?.message || error.message;
    console.error('❌ chakra-send-template:', JSON.stringify(error.response?.data ?? errMsg));
    res.status(status).json({ success: false, error: errMsg, metaCode: metaError?.code });
  }
});

// ─── Envío de imagen ──────────────────────────────────────────────────────────

app.post('/chakra-send-image', async (req, res) => {
  try {
    const { to, image, caption } = req.body;
    if (!to || !image) return res.status(400).json({ success: false, error: 'Faltan parámetros: to, image' });

    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', imageBuffer, { filename: 'ticket.png', contentType: 'image/png' });
    form.append('filename', 'ticket.png');

    const uploadUrl = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/upload-public-media`;
    const uploadRes = await axios.post(uploadUrl, form, {
      headers: { ...chakraHeaders(), ...form.getHeaders() },
      timeout: 30000,
    });

    const publicUrl = uploadRes.data?._data?.publicMediaUrl;
    if (!publicUrl) throw new Error('No se obtuvo publicMediaUrl de Chakra');

    const msgUrl = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${WA_API_VERSION}/${CHAKRA_PHONE_ID}/messages`;
    await axios.post(msgUrl, {
      messaging_product: 'whatsapp',
      to: normalizePhone(to),
      type: 'image',
      image: { link: publicUrl, caption: caption || '🎫 Ticket de venta' },
    }, { headers: chakraHeaders(), timeout: 15000 });

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ chakra-send-image:', JSON.stringify(error.response?.data ?? error.message));
    return res.status(500).json({ success: false, error: error.response?.data?.message || error.message });
  }
});

// ─── Endpoint: marcar reenganche enviado desde el frontend ───────────────────

app.post('/reenganche-sent', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ success: false, error: 'Falta clientId' });
  try {
    const { error, data } = await supabase
      .from('clients')
      .update({ reenganche_sent_at: new Date().toISOString() })
      .eq('id', clientId)
      .select();
    if (error) {
      console.error('❌ /reenganche-sent — no se pudo guardar:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }
    if (!data?.length) {
      console.warn(`⚠️ /reenganche-sent — no se encontró cliente con id ${clientId}`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ /reenganche-sent:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Endpoint: estado de reenganche de clientes ─────────────────────────────

app.get('/reenganche-status', async (req, res) => {
  const { blockDays = 30 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - Number(blockDays));

  const { data, error } = await supabase
    .from('clients')
    .select('id, reenganche_sent_at')
    .not('reenganche_sent_at', 'is', null)
    .gte('reenganche_sent_at', since.toISOString());

  if (error) return res.status(500).json({ success: false, error: error.message });

  const sentIds = (data || []).map(c => c.id);
  res.json({ success: true, sentIds });
});

// ─── Endpoint: marcar mensaje de "Clientes en riesgo" (Dinero Imperium) enviado ─
// Mismo patrón que /reenganche-sent, pero con su propia columna para no mezclar
// el bloqueo de "Clientes en riesgo" con el de "Reenganche" en WhatsApp.tsx.

app.post('/imperium-sent', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ success: false, error: 'Falta clientId' });
  try {
    const { error, data } = await supabase
      .from('clients')
      .update({ imperium_sent_at: new Date().toISOString() })
      .eq('id', clientId)
      .select();
    if (error) {
      console.error('❌ /imperium-sent — no se pudo guardar:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }
    if (!data?.length) {
      console.warn(`⚠️ /imperium-sent — no se encontró cliente con id ${clientId}`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ /imperium-sent:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Endpoint: estado de bloqueo de "Clientes en riesgo" ────────────────────

app.get('/imperium-status', async (req, res) => {
  const { blockDays = 30 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - Number(blockDays));

  const { data, error } = await supabase
    .from('clients')
    .select('id, imperium_sent_at')
    .not('imperium_sent_at', 'is', null)
    .gte('imperium_sent_at', since.toISOString());

  if (error) return res.status(500).json({ success: false, error: error.message });

  const sentIds = (data || []).map(c => c.id);
  res.json({ success: true, sentIds });
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

// ─── Helpers internos del webhook ────────────────────────────────────────────

function normalizarTexto(texto) {
  return texto.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function parsearFechaPedida(txt) {
  const t = normalizarTexto(txt);
  const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);

  if (t.includes('pasado')) {
    const d = new Date(nowMX); d.setDate(d.getDate() + 2); return d;
  }
  if (t.includes('manana') || t.includes('mañana')) {
    const d = new Date(nowMX); d.setDate(d.getDate() + 1); return d;
  }
  if (t.includes('hoy')) {
    return new Date(nowMX);
  }

  const diasMap = [
    { palabras: ['miercoles'], idx: 3 },
    { palabras: ['domingo'],   idx: 0 },
    { palabras: ['lunes'],     idx: 1 },
    { palabras: ['martes'],    idx: 2 },
    { palabras: ['jueves'],    idx: 4 },
    { palabras: ['viernes'],   idx: 5 },
    { palabras: ['sabado'],    idx: 6 },
  ];

  for (const { palabras, idx } of diasMap) {
    if (palabras.some(p => t.includes(p))) {
      const d = new Date(nowMX);
      let diff = idx - d.getDay();
      // Si el día pedido es el mismo que hoy, se interpreta como "hoy",
      // no como el mismo día de la próxima semana.
      if (diff < 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  const numMatch = t.match(/(?:el|d[ií]a|para el)\s+(\d{1,2})(?!\s*(?:am|pm|a\.?m\.?|p\.?m\.?|hrs?))/);
  if (numMatch) {
    const dia = parseInt(numMatch[1], 10);
    if (dia >= 1 && dia <= 31) {
      const d = new Date(nowMX);
      d.setDate(dia);
      if (d <= nowMX) d.setMonth(d.getMonth() + 1);
      return d;
    }
  }

  return null;
}

async function mostrarDisponibilidadEnFecha(from, fechaDate, prefijo = '¡Perfecto! 💈') {
  const { data: barberos } = await supabase.from('barbers').select('id, name, schedule').eq('active', true);
  const dateStr  = toYMD(fechaDate);
  const dayName  = DAY_MAP[fechaDate.getDay()];
  const label    = formatDateMX(fechaDate);
  const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const esHoy = dateStr === nowMX.toISOString().slice(0, 10);
  const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;

  const barberosDelDia = (barberos || []).filter(b => {
    const schedule = Array.isArray(b.schedule) ? b.schedule : [];
    return schedule.some(d => normalizarTexto(d) === normalizarTexto(dayName));
  });

  let haySlots = false;
  let msgSlots = `✂️ *Horarios disponibles — ${label}:*\n\n`;

  for (const b of barberosDelDia) {
    const slots = await getSlotsLibres(b.id, dateStr, horaActual);
    const seleccionados = splitSlots(slots);
    if (!seleccionados.length) continue;
    haySlots = true;
    msgSlots += `👤 *${b.name}:* ${seleccionados.join(' · ')}\n`;
  }

  if (!haySlots || !barberosDelDia.length) {
    const nextDays = getNextDays(7);
    let fallbackDate = null, fallbackLabel = null;
    for (const day of nextDays) {
      const dn = DAY_MAP[day.getDay()];
      const tieneBarbe = (barberos || []).some(b => {
        const schedule = Array.isArray(b.schedule) ? b.schedule : [];
        return schedule.some(d => normalizarTexto(d) === normalizarTexto(dn));
      });
      if (!tieneBarbe) continue;
      const barberosDay = (barberos || []).filter(b => {
        const schedule = Array.isArray(b.schedule) ? b.schedule : [];
        return schedule.some(d => normalizarTexto(d) === normalizarTexto(dn));
      });
      let tieneSlotsLibres = false;
      for (const b of barberosDay) {
        const s = await getSlotsLibres(b.id, toYMD(day), null);
        if (s.length) { tieneSlotsLibres = true; break; }
      }
      if (tieneSlotsLibres) { fallbackDate = day; fallbackLabel = formatDateMX(day); break; }
    }

    if (!fallbackDate) {
      await chakraSendSession(from, `😔 Lo sentimos, ese día no tenemos disponibilidad ni en los días siguientes. Escríbenos para ayudarte a encontrar una fecha.`);
      delete conversationState[from];
      return;
    }

    const fallbackStr = toYMD(fallbackDate);
    const fallbackDayName = DAY_MAP[fallbackDate.getDay()];
    let msgFallback = `😔 El *${label}* no tenemos disponibilidad.\n\nPero el *${fallbackLabel}* sí tenemos espacio:\n\n`;
    const barberosF = (barberos || []).filter(b => {
      const schedule = Array.isArray(b.schedule) ? b.schedule : [];
      return schedule.some(d => normalizarTexto(d) === normalizarTexto(fallbackDayName));
    });
    for (const b of barberosF) {
      const slots = await getSlotsLibres(b.id, fallbackStr, null);
      const seleccionados = splitSlots(slots);
      if (!seleccionados.length) continue;
      msgFallback += `👤 *${b.name}:* ${seleccionados.join(' · ')}\n`;
    }
    msgFallback += `
➡️ Responde con el *nombre del barbero* y la *hora*.
Ej: _Giovanni 15:00_

💡 ¿No conoces a los barberos? Solo manda la *hora* y nosotros te asignamos uno disponible.`;
    conversationState[from] = { step: 'esperando_seleccion', fecha: fallbackStr, fechaLabel: fallbackLabel };
    await chakraSendSession(from, msgFallback);
    return;
  }

  msgSlots += `
➡️ Responde con el *nombre del barbero* y la *hora*.
Ej: _Giovanni 15:00_

💡 ¿No conoces a los barberos? Solo manda la *hora* y nosotros te asignamos uno disponible.
Ej: _15:00_ o _3 pm_`;
  conversationState[from] = { step: 'esperando_seleccion', fecha: dateStr, fechaLabel: label };
  await chakraSendSession(from, `${prefijo} Aquí tienes los horarios disponibles:\n\n${msgSlots}`);
}

// Extrae una hora de un texto libre. Solo reconoce formatos con alta confianza
// (con ":", "am/pm" o "hrs") para no confundirse con números de día como "21".
function extraerHoraDeTexto(text) {
  const intentos = [
    text.match(/(\d{1,2}):(\d{2})\s*(am|pm|a\.?m\.?|p\.?m\.?)?/i), // 5:00 pm / 17:00
    text.match(/(\d{1,2})\s*(am|pm|a\.?m\.?|p\.?m\.?)/i),           // 5 pm
    text.match(/(\d{1,2})\s*(?:hrs|horas|hora|hs)\b/i),             // 18 hrs
  ];
  const m = intentos.find(Boolean);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  let minutes = /^\d+$/.test(m[2] || '') ? parseInt(m[2], 10) : 0;

  const sufijo = (m[3] || m[2] || '').toString().toLowerCase().replace(/\./g, '');
  let meridiano = '';
  if (sufijo.includes('pm')) meridiano = 'pm';
  if (sufijo.includes('am')) meridiano = 'am';

  if (hour > 23 || minutes > 59) return null;
  if (meridiano === 'pm' && hour < 12) hour += 12;
  if (meridiano === 'am' && hour === 12) hour = 0;
  if (!meridiano && hour >= 1 && hour <= 9) hour += 12; // sin sufijo y hora baja -> asumimos PM

  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Cuando el cliente menciona fecha Y hora en el mismo mensaje (ej. "Sábado 10am"),
// esto checa disponibilidad puntual directo en vez de solo mostrarle la lista
// completa del día. Regresa true si ya mandó una respuesta (el caller debe
// hacer `return` inmediatamente); regresa false si no había hora en el mensaje,
// para que el caller siga con el flujo normal (mostrar la lista del día).
async function confirmarHorarioPuntual(from, text, fechaDate, fechaLabel, state) {
  const horaSolicitada = extraerHoraDeTexto(text);
  if (!horaSolicitada) return false;

  if (!getSlotsDelDia(fechaDate).includes(horaSolicitada)) {
    await chakraSendSession(from, `😅 La hora *${horaSolicitada}* no está en nuestro horario (${getHorarioLabel(fechaDate)}).\nDime otra hora o escribe *cancelar*.`);
    return true;
  }

  const dateStr = toYMD(fechaDate);
  const dayName = DAY_MAP[fechaDate.getDay()];
  const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const esHoy = dateStr === nowMX.toISOString().slice(0, 10);
  const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;

  if (esHoy) {
    const [h, m] = horaSolicitada.split(':').map(Number);
    if (h * 60 + m <= horaActual) {
      await chakraSendSession(from, `😅 La hora *${horaSolicitada}* ya pasó. Por favor elige una hora futura.`);
      return true;
    }
  }

  const { data: barberos } = await supabase.from('barbers').select('id, name, schedule').eq('active', true);
  const barberosDelDia = (barberos || []).filter(b => {
    const schedule = Array.isArray(b.schedule) ? b.schedule : [];
    return schedule.some(d => normalizarTexto(d) === normalizarTexto(dayName));
  });

  const disponibles = [];
  for (const b of barberosDelDia) {
    const slotsLibres = await getSlotsLibres(b.id, dateStr, esHoy ? horaActual : null);
    if (slotsLibres.includes(horaSolicitada)) disponibles.push(b);
  }

  if (!disponibles.length) {
    conversationState[from] = { step: 'esperando_hora_especifica', fecha: dateStr, fechaLabel };
    await chakraSendSession(from,
      `😔 A las *${horaSolicitada}* no tenemos a nadie libre el *${fechaLabel}*.\n¿Quieres intentar otra hora o fecha? Dime cuál, o escribe *cancelar*.`
    );
    return true;
  }

  const servicioSolicitado = extraerServicioDelMensaje(text) || state?.serviceName || 'Corte Premium';
  const digits10 = from.replace(/^52/, '').slice(-10);

  const nombreBuscado = normalizarTexto(text);
  let barbero = disponibles.find(b => nombreBuscado.includes(normalizarTexto(b.name)));
  if (!barbero) barbero = disponibles[Math.floor(Math.random() * disponibles.length)];

  conversationState[from] = {
    step: 'confirmando',
    barberoId: barbero.id, barberoName: barbero.name,
    fecha: dateStr, fechaLabel,
    hora: horaSolicitada, horaSeleccionada: horaSolicitada,
    clientPhone: state?.clientPhone || digits10,
    serviceName: servicioSolicitado,
  };
  await chakraSendSession(from,
    `✅ *${barbero.name}* está libre a las *${horaSolicitada}* el *${fechaLabel}*.\n\n` +
    `📋 *Resumen de tu cita:*\n👤 Barbero: *${barbero.name}*\n📅 Fecha: *${fechaLabel}*\n🕐 Hora: *${horaSolicitada}*\n` +
    `¿Confirmas?\n✅ Responde *SÍ* para agendar\n❌ Responde *NO* para cancelar`
  );
  return true;
}

async function prepararFechaYGuardarState(from) {
  const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const todayDayName = DAY_MAP[nowMX.getDay()];
  const { data: barberos } = await supabase.from('barbers').select('id, name, schedule').eq('active', true);

  const hayBarberosHoy = barberos?.some(b => {
    const schedule = Array.isArray(b.schedule) ? b.schedule : [];
    return schedule.some(d => normalizarTexto(d) === normalizarTexto(todayDayName));
  });

  let primerDia = null;
  let primerDiaLabel = null;

  if (hayBarberosHoy) {
    const todayStr = nowMX.toISOString().slice(0, 10);
    const barberosHoy = barberos.filter(b => {
      const schedule = Array.isArray(b.schedule) ? b.schedule : [];
      return schedule.some(d => normalizarTexto(d) === normalizarTexto(todayDayName));
    });
    let haySlots = false;
    const horaActual = nowMX.getHours() * 60 + nowMX.getMinutes();
    for (const b of barberosHoy) {
      const slots = await getSlotsLibres(b.id, todayStr, horaActual);
      if (slots.length) { haySlots = true; break; }
    }
    if (haySlots) { primerDia = todayStr; primerDiaLabel = formatDateMX(nowMX); }
  }

  if (!primerDia) {
    const nextDays = getNextDays(4);
    const { data: bAll } = await supabase.from('barbers').select('id, name, schedule').eq('active', true);
    for (const day of nextDays) {
      const dayName = DAY_MAP[day.getDay()];
      const tieneBarbe = bAll?.some(b => {
        const schedule = Array.isArray(b.schedule) ? b.schedule : [];
        return schedule.some(d => normalizarTexto(d) === normalizarTexto(dayName));
      });
      if (tieneBarbe) { primerDia = toYMD(day); primerDiaLabel = formatDateMX(day); break; }
    }
  }

  if (primerDia) {
    conversationState[from] = { step: 'esperando_seleccion', fecha: primerDia, fechaLabel: primerDiaLabel };
  }
  return { primerDia, primerDiaLabel };
}

// ─── Función para obtener o crear servicio ──────────────────────────────────

async function obtenerOCrearServicio(nombreBuscado = null) {
  // Si se especificó un nombre, intentar encontrarlo
  if (nombreBuscado) {
    const nombreNormalizado = normalizarTexto(nombreBuscado);
    const { data: servicios } = await supabase
      .from('services')
      .select('id, name, price, duration')
      .eq('active', true);

    for (const servicio of (servicios || [])) {
      if (normalizarTexto(servicio.name).includes(nombreNormalizado) || 
          nombreNormalizado.includes(normalizarTexto(servicio.name))) {
        return servicio;
      }
    }
  }

  // Si no se encontró o no se especificó, buscar "Corte Premium"
  const { data: premiumService } = await supabase
    .from('services')
    .select('id, name, price, duration')
    .ilike('name', '%corte premium%')
    .eq('active', true)
    .maybeSingle();

  if (premiumService) {
    return premiumService;
  }

  // Si no existe "Corte Premium", buscar cualquier servicio activo
  const { data: anyService } = await supabase
    .from('services')
    .select('id, name, price, duration')
    .eq('active', true)
    .limit(1)
    .maybeSingle();

  if (anyService) {
    return anyService;
  }

  // Si no hay servicios, crear "Corte Premium"
  const { data: newService, error } = await supabase
    .from('services')
    .insert([{
      name: 'Corte Premium',
      price: 350,
      duration: 60,
      category: 'Corte',
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }])
    .select()
    .single();

  if (!error && newService) {
    console.log(`✅ Servicio creado automáticamente: ${newService.name}`);
    return newService;
  }

  console.error('❌ Error al crear servicio por defecto:', error?.message);
  return null;
}

// ─── Función para obtener o crear cliente ───────────────────────────────────

async function obtenerOCrearCliente(phone, name = null) {
  const digits10 = phone.replace(/^52/, '').slice(-10);

  // Buscar cliente existente. Usamos .limit(1) en vez de .maybeSingle() porque
  // .maybeSingle() truena si el ilike hace match con MÁS de un registro (ej. el
  // mismo teléfono guardado dos veces con formato distinto) — eso hacía que el
  // error se ignorara silenciosamente (solo se destructuraba `data`) y el código
  // pensara que el cliente no existía, intentando crear uno nuevo con el mismo
  // teléfono y tronando por duplicado en el insert.
  const { data: existingClients, error: findError } = await supabase
    .from('clients')
    .select('id, name, phone')
    .ilike('phone', `%${digits10}%`)
    .order('created_at', { ascending: false })
    .limit(1);

  if (findError) {
    console.error('⚠️ Error buscando cliente existente:', findError.message);
  }

  const existingClient = existingClients?.[0] || null;
  if (existingClient) {
    return existingClient;
  }

  // Crear nuevo cliente
  const nombreCliente = name || 'Cliente WhatsApp';
  // loyalty_level es NOT NULL y tiene un check constraint que solo acepta
  // 'bronce' | 'plata' | 'oro' | 'platino'. Un cliente nuevo arranca en 'bronce'.
  let { data: newClient, error } = await supabase
    .from('clients')
    .insert([{
      name: nombreCliente,
      phone: digits10,
      loyalty_level: 'bronce',
      created_at: new Date().toISOString(),
    }])
    .select()
    .single();

  if (error) {
    console.error('❌ Error creando cliente:', error.message);

    // Si el error es por teléfono duplicado (el cliente en realidad ya existía
    // pero no lo detectamos arriba por algún formato distinto), intentamos
    // recuperarlo en vez de fallar el agendado completo.
    const { data: recuperado } = await supabase
      .from('clients')
      .select('id, name, phone')
      .ilike('phone', `%${digits10}%`)
      .order('created_at', { ascending: false })
      .limit(1);

    if (recuperado?.[0]) {
      console.log(`♻️ Cliente recuperado tras error de duplicado: ${recuperado[0].name} (${recuperado[0].phone})`);
      return recuperado[0];
    }

    return null;
  }

  console.log(`✅ Cliente creado: ${newClient.name} (${newClient.phone})`);
  return newClient;
}

// ─── Función para extraer servicio del mensaje ──────────────────────────────

function extraerServicioDelMensaje(text) {
  const textoLower = normalizarTexto(text);

  // Combos específicos primero (más específico gana), luego servicios individuales.
  // El nombre de la izquierda es lo que se busca en el texto; el de la derecha es
  // el nombre canónico que se guarda/muestra.
  const candidatos = [
    { patron: /corte\s*y\s*barba|barba\s*y\s*corte/, nombre: 'Corte y Barba' },
    { patron: /corte\s*(de\s*)?barba/, nombre: 'Corte y Barba' }, // "corte de barba" = quiere ambos
    { patron: /\bbarba\b/, nombre: 'Barba' },
    { patron: /\bafeitado\b/, nombre: 'Afeitado' },
    { patron: /\btinte\b/, nombre: 'Tinte' },
    { patron: /\bcejas\b/, nombre: 'Perfilado de Cejas' },
    { patron: /\bperfilado\b/, nombre: 'Perfilado de Cejas' },
    { patron: /corte\s*(premium|clasico|ejecutivo|especial)/, nombre: null }, // se resuelve abajo con el modificador
    { patron: /\bcorte\b/, nombre: 'Corte Premium' },
  ];

  for (const { patron, nombre } of candidatos) {
    const match = textoLower.match(patron);
    if (match) {
      if (nombre) return nombre;
      // Caso "corte premium/clasico/ejecutivo/especial" → arma el nombre con el modificador
      const modificador = match[1];
      const nombreBonito = modificador
        .replace('clasico', 'Clásico')
        .replace(/^./, c => c.toUpperCase());
      return `Corte ${nombreBonito}`;
    }
  }
  return null;
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry    = req.body.entry?.[0];
    const changes  = entry?.changes?.[0];
    const value    = changes?.value;

    const statuses = value?.statuses;
    if (statuses?.length) {
      for (const s of statuses) {
        if (s.status === 'failed') {
          console.error(`❌ ENTREGA FALLIDA — wamid ${s.id} a ${s.recipient_id}:`, JSON.stringify(s.errors));
        } else {
          console.log(`📬 Estado wamid ${s.id} → ${s.recipient_id}: ${s.status}`);
        }
      }
    }

    const messages = value?.messages;
    if (!messages?.length) return;

    const msg  = messages[0];
    const from = msg.from;

    if (yaFueProcesado(msg.id)) {
      console.log(`♻️ Webhook duplicado ignorado (wamid ${msg.id})`);
      return;
    }

    if (msg.type === 'interactive') {
      const buttonReply = msg.interactive?.button_reply;
      const listReply   = msg.interactive?.list_reply;
      const buttonText  = (buttonReply?.title || listReply?.title || '').toLowerCase();
      const buttonId    = (buttonReply?.id    || listReply?.id    || '').toLowerCase();

      console.log(`🔘 Botón de ${from}: "${buttonText}" (id: "${buttonId}")`);

      const { client, cita } = await getClienteYCita(from);
      if (!client || !cita) return;

      const firstName      = client.name.split(' ')[0];
      const esConfirmacion = ['sí, confirmo', 'confirmo', 'sí', 'si', 'yes'].some(k => buttonText.includes(k) || buttonId.includes(k));
      const esCancelacion  = ['no puedo asistir', 'cancelar', 'no'].some(k => buttonText.includes(k) || buttonId.includes(k));

      if (esConfirmacion && cita.status !== 'confirmada') {
        await supabase.from('appointments').update({ status: 'confirmada' }).eq('id', cita.id);
        await chakraSendSession(from,
          `✅ ¡Perfecto ${firstName}! Tu cita del *${cita.date}* a las *${cita.time}* con *${cita.barber_name ?? 'tu barbero'}* queda confirmada. ¡Te esperamos! 💈`
        );
        console.log(`✅ Cita ${cita.id} confirmada por botón para ${client.name}`);
      } else if (esCancelacion) {
        await supabase.from('appointments').update({ status: 'cancelada' }).eq('id', cita.id);
        await chakraSendSession(from,
          `❌ Entendido ${firstName}, tu cita del *${cita.date}* ha sido cancelada. Si quieres reagendar escribe *hola* cuando gustes 🙌`
        );
        console.log(`❌ Cita ${cita.id} cancelada por botón para ${client.name}`);
      }
      return;
    }

    if (msg.type !== 'text') return;

    const text      = msg.text.body.trim();
    const textLower = text.toLowerCase();
    console.log(`📩 WhatsApp de ${from}: "${text}"`);

    // ══════════════════════════════════════════════════════════════════════════
    // 🔧 MODO DE PRUEBA
    // TEST_MODE = true  → solo responde a números en TEST_WHITELIST
    // TEST_MODE = false → responde a todos (producción normal)
    // ══════════════════════════════════════════════════════════════════════════
    const TEST_MODE = process.env.TEST_MODE === 'false'; // por defecto false: producción responde a todos
    const TEST_WHITELIST = [
      '5212711674600',
      '5215523297565'  // ← agrega aquí tus números de prueba (sin + ni espacios)
    ];

    if (TEST_MODE) {
      const fromNorm = normalizePhone(from);
      if (!TEST_WHITELIST.some(n => normalizePhone(n) === fromNorm)) {
        console.log(`⏸️ Modo prueba — mensaje de ${from} ignorado`);
        return;
      }
      console.log(`✅ Modo prueba — procesando mensaje de ${from}`);
    }

    const state = conversationState[from];

    // ── Pregunta por ubicación (funciona en cualquier momento, sin importar el step) ──
    const esUbicacion = [
      'ubicados', 'ubicacion', 'ubicación', 'donde estan', 'dónde están',
      'donde están', 'dónde estan', 'donde queda', 'dónde queda',
      'direccion', 'dirección', 'como llegar', 'cómo llegar', 'donde se encuentran',
      'dónde se encuentran', 'localizacion', 'localización', 'mapa', 'maps'
    ].some(k => textLower.includes(k));
    if (esUbicacion) {
      await chakraSendLocation(from);
      await chakraSendSession(from, `¡Te esperamos! 💈`);
      return;
    }

    if (state && ['cancelar', 'salir', 'cancel', 'exit'].some(k => textLower.includes(k))) {
      delete conversationState[from];
      const { client } = await getClienteYCita(from);
      await chakraSendSession(from, `Ok ${client?.name?.split(' ')[0] || 'amigo'}, cancelé el proceso. Escríbeme *hola* cuando quieras agendar. 👍`);
      return;
    }

    // ── Reagendar cita existente (cambiar fecha/hora sin cancelar) ───────────
    // Permite que el cliente mueva su cita a otro día/hora en un solo flujo,
    // sin tener que escribir "cancelar" y volver a empezar desde cero.
    const esReagendar = [
      'reagendar', 're agendar', 'reprogramar',
      'cambiar mi cita', 'cambiar la cita', 'cambiar de cita',
      'cambiar de fecha', 'cambiar de dia', 'cambiar de día',
      'mover mi cita', 'mover la cita', 'cambiar horario de mi cita',
      'otro dia para mi cita', 'otro día para mi cita', 'otra fecha para mi cita',
      'cambiar mi hora', 'moverla', 'cambiarla de dia', 'cambiarla de día',
    ].some(k => textLower.includes(k));

    const enFlujoReagendar = ['reagendar_fecha', 'reagendar_seleccion', 'reagendar_confirmando'].includes(state?.step);

    if (esReagendar && !enFlujoReagendar) {
      let { client: clienteReagendar, cita: citaReagendar } = await getClienteYCita(from);

      // Si no tiene cita activa, puede ser que se la acaben de cancelar
      // (ej. el staff canceló y ofreció reagendar en el mismo momento).
      if (!citaReagendar) {
        const fallback = await getCitaCanceladaReciente(from);
        if (fallback.client && fallback.cita) {
          clienteReagendar = fallback.client;
          citaReagendar = fallback.cita;
        }
      }

      const nombreReagendar = clienteReagendar?.name?.split(' ')[0] || 'amigo';

      if (!clienteReagendar || !citaReagendar) {
        await chakraSendSession(from, `Hola ${nombreReagendar} 👋 No encontré ninguna cita próxima a tu nombre.\n\nEscribe *hola* para ver horarios y agendar una cita nueva. 💈`);
        return;
      }

      conversationState[from] = {
        step: 'reagendar_fecha',
        citaId: citaReagendar.id,
        citaFechaOriginal: citaReagendar.date,
        citaHoraOriginal: citaReagendar.time,
        barberoId: citaReagendar.barber_id || null,
        barberoName: citaReagendar.barber_name || null,
        serviceId: citaReagendar.service_id || null,
        serviceName: citaReagendar.service_name || 'Corte Premium',
        clientPhone: clienteReagendar.phone,
      };

      const eraDeYaCancelada = citaReagendar.status === 'cancelada';
      const fraseSinCancelar = eraDeYaCancelada
        ? `Vamos a reagendar tu cita del *${formatFechaCorta(citaReagendar.date)}* a las *${citaReagendar.time}*`
        : `Vamos a cambiar tu cita del *${formatFechaCorta(citaReagendar.date)}* a las *${citaReagendar.time}*, sin cancelarla`;
      await chakraSendSession(from,
        `¡Claro ${nombreReagendar}! ${fraseSinCancelar}. 🙌\n\n¿Para qué día la quieres? (ej. _viernes_, _mañana_, _10 de julio_)`
      );
      return;
    }

    // ── Reagendar: esperando la nueva fecha ──────────────────────────────────
    if (state?.step === 'reagendar_fecha') {
      const fechaPedida = parsearFechaPedida(text);
      if (!fechaPedida) {
        await chakraSendSession(from, `No entendí la fecha 😅\nDime algo como *viernes*, *mañana* o *10 de julio*, o escribe *cancelar* para salir (tu cita original no se toca).`);
        return;
      }

      const fechaStr   = toYMD(fechaPedida);
      const fechaLabel = formatDateMX(fechaPedida);
      const dayName    = DAY_MAP[fechaPedida.getDay()];
      const nowMX      = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const esHoy      = fechaStr === nowMX.toISOString().slice(0, 10);
      const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;

      const { data: barberosDisp } = await supabase.from('barbers').select('id, name, schedule').eq('active', true);
      const barberosDelDia = (barberosDisp || []).filter(b => {
        const schedule = Array.isArray(b.schedule) ? b.schedule : [];
        return schedule.some(d => normalizarTexto(d) === normalizarTexto(dayName));
      });

      let msgSlots = '';
      let haySlots = false;
      for (const b of barberosDelDia) {
        const slots = await getSlotsLibres(b.id, fechaStr, horaActual);
        const seleccionados = splitSlots(slots);
        if (!seleccionados.length) continue;
        haySlots = true;
        msgSlots += `👤 *${b.name}:* ${seleccionados.join(' · ')}\n`;
      }

      if (!haySlots) {
        await chakraSendSession(from,
          `😔 El *${fechaLabel}* no tenemos disponibilidad.\n¿Quieres intentar otro día? Dime cuál, o escribe *cancelar* (tu cita original se mantiene).`
        );
        return;
      }

      conversationState[from] = { ...state, step: 'reagendar_seleccion', fecha: fechaStr, fechaLabel };
      await chakraSendSession(from,
        `✂️ *Horarios disponibles — ${fechaLabel}:*\n\n${msgSlots}\n` +
        `➡️ Responde con el *nombre del barbero* y la *hora* (ej. _Giovanni 15:00_), o solo la *hora* y te asignamos a alguien libre.`
      );
      return;
    }

    // ── Reagendar: esperando barbero + hora ──────────────────────────────────
    if (state?.step === 'reagendar_seleccion') {
      const horaSolicitada = extraerHoraDeTexto(text);
      if (!horaSolicitada || !getSlotsDelDia(state.fecha).includes(horaSolicitada)) {
        await chakraSendSession(from, `No entendí la hora 😅\nDime algo como *17:00*, *5 pm* o *18 hrs* (horario: ${getHorarioLabel(state.fecha)}), o escribe *cancelar*.`);
        return;
      }

      const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const esHoy = state.fecha === nowMX.toISOString().slice(0, 10);
      const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;

      const { data: barberos } = await supabase.from('barbers').select('id, name').eq('active', true);
      const disponibles = [];
      for (const b of (barberos || [])) {
        const slotsLibres = await getSlotsLibres(b.id, state.fecha, horaActual);
        if (slotsLibres.includes(horaSolicitada)) disponibles.push(b);
      }

      if (!disponibles.length) {
        await chakraSendSession(from, `😔 A las *${horaSolicitada}* no tengo a nadie libre el *${state.fechaLabel}*.\n¿Quieres intentar otra hora? Dime cuál, o escribe *cancelar*.`);
        return;
      }

      const nombreBuscado = normalizarTexto(text);
      let barberoElegido = disponibles.find(b => nombreBuscado.includes(normalizarTexto(b.name)));
      if (!barberoElegido) {
        barberoElegido = disponibles[Math.floor(Math.random() * disponibles.length)];
      }

      conversationState[from] = {
        ...state,
        step: 'reagendar_confirmando',
        hora: horaSolicitada,
        barberoId: barberoElegido.id,
        barberoName: barberoElegido.name,
      };
      await chakraSendSession(from,
        `📋 *Nuevo horario de tu cita:*\n👤 Barbero: *${barberoElegido.name}*\n📅 Fecha: *${state.fechaLabel}*\n🕐 Hora: *${horaSolicitada}*\n` +
        `¿Confirmas el cambio?\n✅ Responde *SÍ* para actualizar tu cita\n❌ Responde *NO* para dejarla como estaba`
      );
      return;
    }

    // ── Reagendar: confirmación final (actualiza la cita, no crea una nueva) ─
    if (state?.step === 'reagendar_confirmando') {
      const confirma = ['sí', 'si', 'yes', 'confirmo', 'ok', '1', '✅'].some(k => textLower.includes(k));
      const noConfirma = ['no', 'cancelar', 'cancel', '2'].some(k => textLower.includes(k));

      if (confirma) {
        const endTime = (() => {
          const [h, m] = state.hora.split(':').map(Number);
          const end = h * 60 + m + 60;
          return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
        })();

        const { error } = await supabase
          .from('appointments')
          .update({
            date: state.fecha,
            time: state.hora,
            end_time: endTime,
            barber_id: state.barberoId,
            barber_name: state.barberoName,
            status: 'pendiente',
            reminder_sent: false,
            notes: `Reagendado por WhatsApp desde ${state.citaFechaOriginal} ${state.citaHoraOriginal}.`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', state.citaId);

        delete conversationState[from];

        if (error) {
          console.error('❌ Error reagendando cita:', error.message);
          await chakraSendSession(from, `¡Gracias! 🙌 Ya casi tenemos listo tu cambio de cita — en un momento el equipo te lo confirma personalmente.`);
          await alertarEquipoManual({
            cliente: state.clientPhone || from,
            fechaHora: `${state.fecha} ${state.hora} (cita original: ${state.citaFechaOriginal} ${state.citaHoraOriginal})`,
            barbero: state.barberoName,
            detalle: `No se pudo reagendar automáticamente la cita ${state.citaId}. Error: ${error.message}`,
          });
          return;
        }

        console.log(`🔁 Cita ${state.citaId} reagendada a ${state.fecha} ${state.hora} con ${state.barberoName}`);
        await chakraSendSession(from,
          `✅ ¡Listo! Tu cita fue actualizada:\n\n` +
          `👤 Barbero: *${state.barberoName}*\n` +
          `📅 Nueva fecha: *${state.fechaLabel}*\n` +
          `🕐 Nueva hora: *${state.hora}*\n\n` +
          `Te esperamos en Imperium Caesar's Barber Club 💈`
        );
      } else if (noConfirma) {
        delete conversationState[from];
        await chakraSendSession(from, `Ok, dejé tu cita como estaba: *${formatFechaCorta(state.citaFechaOriginal)}* a las *${state.citaHoraOriginal}*. Escríbeme *hola* si necesitas algo más 👍`);
      } else {
        await chakraSendSession(from, `Responde *SÍ* para confirmar el cambio de tu cita o *NO* para dejarla como estaba.`);
      }
      return;
    }

    // ── Quiere otro horario ──────────────────────────────────────────────────
    const esOtroHorario = [
      'otro horario', 'otra hora', 'otros horarios',
      'algo más tarde', 'algo mas tarde', 'algo más temprano', 'algo mas temprano',
      'no me sirve', 'no me queda', 'tienes otro', 'hay otro horario', 'más tarde', 'mas tarde',
      'tendrás disponible', 'tienes disponible', 'hay disponible', 'disponible',
      'a las', 'a la', 'hrs', 'horas',
    ].some(k => textLower.includes(k));

    if (esOtroHorario && state?.step !== 'confirmando') {
      // Si el mensaje ya trae una fecha explícita (ej. "mejor viernes a las 4pm"),
      // usarla en vez de asumir la fecha que ya estaba en el estado (o "hoy").
      const fechaEnMensajeOtroHorario = parsearFechaPedida(text);
      if (fechaEnMensajeOtroHorario) {
        const fechaLabelNueva = formatDateMX(fechaEnMensajeOtroHorario);
        const yaRespondido = await confirmarHorarioPuntual(from, text, fechaEnMensajeOtroHorario, fechaLabelNueva, state);
        if (yaRespondido) return;
        await mostrarDisponibilidadEnFecha(from, fechaEnMensajeOtroHorario, '¡Claro!');
        return;
      }

      let fecha = state?.fecha;
      let fechaLabel = state?.fechaLabel;
      if (!fecha) {
        const nextDays = getNextDays(4);
        const { data: barberosDisp } = await supabase.from('barbers').select('id, name, schedule').eq('active', true);
        for (const day of nextDays) {
          const dayName = DAY_MAP[day.getDay()];
          const tieneBarbe = barberosDisp?.some(b => {
            const schedule = Array.isArray(b.schedule) ? b.schedule : [];
            return schedule.some(d => normalizarTexto(d) === normalizarTexto(dayName));
          });
          if (tieneBarbe) { fecha = toYMD(day); fechaLabel = formatDateMX(day); break; }
        }
      }

      // ── Si el mensaje ya trae la hora en frases como "a las 10" o "está bien a las 10",
      // procesarla directamente en vez de volver a preguntar la hora ──
      const laHoraMatch = text.match(/a\s+las?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?/i);
      if (laHoraMatch) {
        let hour = parseInt(laHoraMatch[1], 10);
        const minutes = laHoraMatch[2] ? parseInt(laHoraMatch[2], 10) : 0;
        const meridiano = laHoraMatch[3]?.toLowerCase().replace(/\./g, '') || '';
        if (meridiano === 'pm' && hour < 12) hour += 12;
        if (meridiano === 'am' && hour === 12) hour = 0;
        if (!meridiano && hour >= 1 && hour <= 9) hour += 12;
        const horaSolicitada = `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

        if (getSlotsDelDia(fecha).includes(horaSolicitada)) {
          const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
          const todayStr = nowMX.toISOString().slice(0, 10);
          const esHoy = fecha === todayStr;
          const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;
          let horaPasada = false;
          if (esHoy) {
            const [h, m] = horaSolicitada.split(':').map(Number);
            if (h * 60 + m <= horaActual) horaPasada = true;
          }

          if (!horaPasada) {
            const { data: barberosLaHora } = await supabase.from('barbers').select('id, name').eq('active', true);
            const disponiblesLaHora = [];
            for (const barbero of (barberosLaHora || [])) {
              const slotsLibres = await getSlotsLibres(barbero.id, fecha, esHoy ? horaActual : null);
              if (slotsLibres.includes(horaSolicitada)) disponiblesLaHora.push(barbero);
            }

            const servicioSolicitado = extraerServicioDelMensaje(text);
            const digits10 = from.replace(/^52/, '').slice(-10);

            if (disponiblesLaHora.length >= 1) {
              const nombreBuscado = normalizarTexto(text);
              const barbero = disponiblesLaHora.find(b => nombreBuscado.includes(normalizarTexto(b.name)))
                || disponiblesLaHora[Math.floor(Math.random() * disponiblesLaHora.length)];
              conversationState[from] = {
                step: 'confirmando',
                barberoId: barbero.id, barberoName: barbero.name,
                fecha, fechaLabel,
                hora: horaSolicitada,
                horaSeleccionada: horaSolicitada,
                clientPhone: digits10,
                serviceName: servicioSolicitado || 'Corte Premium',
              };
              await chakraSendSession(from,
                `✅ *${barbero.name}* está libre a las *${horaSolicitada}* el *${fechaLabel}*.\n\n` +
                `📋 *Resumen de tu cita:*\n👤 Barbero: *${barbero.name}*\n📅 Fecha: *${fechaLabel}*\n🕐 Hora: *${horaSolicitada}*\n` +
                `¿Confirmas?\n✅ Responde *SÍ* para agendar\n❌ Responde *NO* para cancelar`
              );
              return;
            }
          }
        }
        // Si la hora no es válida, ya pasó, o no hay nadie libre, seguimos con el flujo normal abajo (se le pedirá la hora de nuevo).
      }

      conversationState[from] = { step: 'esperando_hora_especifica', fecha, fechaLabel };
      await chakraSendSession(from, `Claro 🙌 ¿A qué hora te gustaría? Dime la hora (ej: *17:00*, *5:00 pm* o *18 hrs*) y te digo si hay alguien disponible.`);
      return;
    }

    // ── Esperando hora específica ────────────────────────────────────────────
    if (state?.step === 'esperando_hora_especifica') {
      // Si menciona una fecha explícita ("sábado", "mañana", etc.), checar esa
      // fecha — y si también dio una hora en el mismo mensaje, ir directo a
      // confirmar disponibilidad puntual en vez de solo mostrar la lista.
      const fechaEnMensaje = parsearFechaPedida(text);
      if (fechaEnMensaje) {
        const yaRespondido = await confirmarHorarioPuntual(from, text, fechaEnMensaje, formatDateMX(fechaEnMensaje), state);
        if (yaRespondido) return;
        await mostrarDisponibilidadEnFecha(from, fechaEnMensaje, '¡Claro!');
        return;
      }

      let horaMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?/i);
      
      if (!horaMatch) {
        const hrsMatch = text.match(/(\d{1,2})\s*(?:hrs|horas|hora|hs)/i);
        if (hrsMatch) {
          horaMatch = [null, hrsMatch[1], null, null];
        }
      }

      if (!horaMatch) {
        await chakraSendSession(from, `No entendí la hora 😅\nDime algo como *17:00*, *5:00 pm* o *18 hrs*, o escribe *cancelar*.`);
        return;
      }

      let hour = parseInt(horaMatch[1], 10);
      const minutes = horaMatch[2] ? parseInt(horaMatch[2], 10) : 0;
      const meridiano = horaMatch[3]?.toLowerCase().replace(/\./g, '');
      
      if (hour > 23 || hour < 0 || minutes > 59) {
        await chakraSendSession(from, `Hora inválida 😅\nDime una hora dentro de nuestro horario (${getHorarioLabel(state.fecha)}).`);
        return;
      }
      
      if (meridiano === 'pm' && hour < 12) hour += 12;
      if (meridiano === 'am' && hour === 12) hour = 0;
      if (!meridiano && hour >= 1 && hour <= 9) hour += 12;
      
      const horaSolicitada = `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      
      if (!getSlotsDelDia(state.fecha).includes(horaSolicitada)) {
        await chakraSendSession(from, `❌ No tenemos ese horario. Los slots son cada 30 minutos, de *${getHorarioLabel(state.fecha)}*.`);
        return;
      }

      const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const todayStr = nowMX.toISOString().slice(0, 10);
      const esHoy = state.fecha === todayStr;
      const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;
      
      if (esHoy) {
        const [h, m] = horaSolicitada.split(':').map(Number);
        if (h * 60 + m <= horaActual) {
          await chakraSendSession(from, `😅 La hora *${horaSolicitada}* ya pasó. Por favor elige una hora futura.`);
          return;
        }
      }

      const { data: barberos } = await supabase.from('barbers').select('id, name').eq('active', true);
      const disponibles = [];
      for (const barbero of (barberos || [])) {
        const slotsLibres = await getSlotsLibres(barbero.id, state.fecha, esHoy ? horaActual : null);
        if (slotsLibres.includes(horaSolicitada)) disponibles.push(barbero);
      }

      if (!disponibles.length) {
        await chakraSendSession(from,
          `😔 A las *${horaSolicitada}* no tengo a nadie libre el *${state.fechaLabel}*.\n¿Quieres intentar otra hora? Dime cuál, o escribe *cancelar*.`
        );
        return;
      }

      const servicioSolicitado = extraerServicioDelMensaje(text);
      const digits10 = from.replace(/^52/, '').slice(-10);

      const nombreBuscado = normalizarTexto(text);
      const barbero = disponibles.find(b => nombreBuscado.includes(normalizarTexto(b.name)))
        || disponibles[Math.floor(Math.random() * disponibles.length)];

      conversationState[from] = {
        step: 'confirmando',
        barberoId: barbero.id, barberoName: barbero.name,
        fecha: state.fecha, fechaLabel: state.fechaLabel,
        hora: horaSolicitada,
        horaSeleccionada: horaSolicitada,
        clientPhone: digits10,
        serviceName: servicioSolicitado || 'Corte Premium',
      };
      await chakraSendSession(from,
        `✅ *${barbero.name}* está libre a las *${horaSolicitada}* el *${state.fechaLabel}*.\n\n` +
        `📋 *Resumen de tu cita:*\n👤 Barbero: *${barbero.name}*\n📅 Fecha: *${state.fechaLabel}*\n🕐 Hora: *${horaSolicitada}*\n` +
        `¿Confirmas?\n✅ Responde *SÍ* para agendar\n❌ Responde *NO* para cancelar`
      );
      return;
    }

    // ── Esperando selección ──────────────────────────────────────────────────
    if (state?.step === 'esperando_seleccion') {
      const fechaEnMensaje = parsearFechaPedida(text);
      if (fechaEnMensaje) {
        const yaRespondido = await confirmarHorarioPuntual(from, text, fechaEnMensaje, formatDateMX(fechaEnMensaje), state);
        if (yaRespondido) return;
        await mostrarDisponibilidadEnFecha(from, fechaEnMensaje, '¡Claro!');
        return;
      }

      if (textLower.includes('cualquiera') || textLower.includes('cualquier')) {
        const { data: barberos } = await supabase.from('barbers').select('id, name').eq('active', true);
        const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const esHoy = state.fecha === nowMX.toISOString().slice(0, 10);
        const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;
        
        // ✅ Buscar la hora que el cliente ya había seleccionado
        let horaSeleccionada = state.horaSeleccionada || null;
        
        let barberoAsignado = null;
        let horaAsignada = null;
        
        // Si el cliente ya tenía una hora seleccionada, elegir al azar entre
        // TODOS los barberos disponibles a esa hora (no siempre el primero).
        if (horaSeleccionada) {
          const disponiblesHora = [];
          for (const barbero of (barberos || [])) {
            const slotsLibres = await getSlotsLibres(barbero.id, state.fecha, horaActual);
            if (slotsLibres.includes(horaSeleccionada)) disponiblesHora.push(barbero);
          }
          if (disponiblesHora.length) {
            barberoAsignado = disponiblesHora[Math.floor(Math.random() * disponiblesHora.length)];
            horaAsignada = horaSeleccionada;
          }
        }
        
        // Si no se encontró barbero a esa hora o no había hora seleccionada,
        // elegir al azar entre los barberos con espacio ese día, y de ahí
        // tomar al azar uno de sus primeros slots libres.
        if (!barberoAsignado) {
          const barberosConEspacio = [];
          for (const barbero of (barberos || [])) {
            const slotsLibres = await getSlotsLibres(barbero.id, state.fecha, horaActual);
            if (slotsLibres.length > 0) barberosConEspacio.push({ barbero, slotsLibres });
          }
          if (barberosConEspacio.length) {
            const elegido = barberosConEspacio[Math.floor(Math.random() * barberosConEspacio.length)];
            barberoAsignado = elegido.barbero;
            horaAsignada = elegido.slotsLibres[Math.floor(Math.random() * elegido.slotsLibres.length)];
          }
        }
        
        if (!barberoAsignado || !horaAsignada) {
          await chakraSendSession(from, `😔 No tengo barberos disponibles para ese día. ¿Quieres probar otra fecha?`);
          return;
        }
        
        const servicioSolicitado = extraerServicioDelMensaje(text) || state.serviceName || 'Corte Premium';
        const digits10 = from.replace(/^52/, '').slice(-10);
        
        conversationState[from] = {
          step: 'confirmando',
          barberoId: barberoAsignado.id, barberoName: barberoAsignado.name,
          fecha: state.fecha, fechaLabel: state.fechaLabel,
          hora: horaAsignada,
          horaSeleccionada: horaAsignada,
          clientPhone: state.clientPhone || digits10,
          serviceName: servicioSolicitado,
        };
        
        await chakraSendSession(from,
          `👍 Te asignamos a *${barberoAsignado.name}* a las *${horaAsignada}* el *${state.fechaLabel}*.\n\n` +
          `📋 *Resumen de tu cita:*\n` +
          `👤 Barbero: *${barberoAsignado.name}*\n` +
          `📅 Fecha: *${state.fechaLabel}*\n` +
          `🕐 Hora: *${horaAsignada}*\n` +
          `` +
          `¿Confirmas?\n✅ Responde *SÍ* para agendar\n❌ Responde *NO* para cancelar`
        );
        return;
      }

      let matchNombreHora = null;
      let soloHoraMatch = null;
      
      const horaConNombre = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?\s*(?:con|para|de|a las)\s*([a-záéíóúñA-ZÁÉÍÓÚÑ\s]+)/i);
      if (horaConNombre) {
        matchNombreHora = {
          hora: horaConNombre[1],
          minutos: horaConNombre[2] || '00',
          meridiano: horaConNombre[3] || '',
          nombre: horaConNombre[4].trim()
        };
      } else {
        const nombreHora = text.match(/([a-záéíóúñA-ZÁÉÍÓÚÑ]+(?:\s+[a-záéíóúñA-ZÁÉÍÓÚÑ]+)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?/i);
        if (nombreHora) {
          matchNombreHora = {
            nombre: nombreHora[1].trim(),
            hora: nombreHora[2],
            minutos: nombreHora[3] || '00',
            meridiano: nombreHora[4] || ''
          };
        } else {
          // ── Hora seguida del nombre SIN conector (ej. "14:00 Raúl") ──────────
          // Antes esto caía directo a "solo hora" e ignoraba el nombre por completo,
          // asignando un barbero al azar en vez del que el cliente pidió.
          // Validamos contra la lista real de barberos para no confundir palabras
          // sueltas ("14:00 porfa", "18:30 gracias") con un nombre.
          const horaNombreSinConector = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?\s+([a-záéíóúñA-ZÁÉÍÓÚÑ]+(?:\s+[a-záéíóúñA-ZÁÉÍÓÚÑ]+)?)\s*$/i);
          if (horaNombreSinConector) {
            const posibleNombre = normalizarTexto(horaNombreSinConector[4]);
            const { data: barberosCheck } = await supabase.from('barbers').select('name').eq('active', true);
            const coincide = (barberosCheck || []).some(b => {
              const nb = normalizarTexto(b.name);
              return nb.includes(posibleNombre) || posibleNombre.includes(nb);
            });
            if (coincide) {
              matchNombreHora = {
                hora: horaNombreSinConector[1],
                minutos: horaNombreSinConector[2] || '00',
                meridiano: horaNombreSinConector[3] || '',
                nombre: horaNombreSinConector[4].trim()
              };
            }
          }

          if (!matchNombreHora) {
            const solo = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?|hrs?)?/i);
            if (solo) {
              soloHoraMatch = solo;
            }
          }
        }
      }

      if (matchNombreHora) {
        let hour = parseInt(matchNombreHora.hora, 10);
        const minutes = parseInt(matchNombreHora.minutos, 10) || 0;
        const meridiano = matchNombreHora.meridiano?.toLowerCase().replace(/\./g, '').replace('hrs', '').trim() || '';
        
        if (meridiano === 'pm' && hour < 12) hour += 12;
        if (meridiano === 'am' && hour === 12) hour = 0;
        if (!meridiano && hour >= 1 && hour <= 9) hour += 12;
        
        const horaSolicitada = `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        
        if (!getSlotsDelDia(state.fecha).includes(horaSolicitada)) {
          await chakraSendSession(from,
            `😅 La hora *${horaSolicitada}* no está en nuestro horario (${getHorarioLabel(state.fecha)}).\nDime otra hora o escribe *cancelar*.`
          );
          return;
        }

        const servicioSolicitado = extraerServicioDelMensaje(text) || state.serviceName || 'Corte Premium';

        const nombreBuscado = normalizarTexto(matchNombreHora.nombre);
        const { data: barberos } = await supabase.from('barbers').select('id, name').eq('active', true);

        const barbero = barberos?.find(b => {
          const nombreBarbero = normalizarTexto(b.name);
          return nombreBarbero.includes(nombreBuscado) || nombreBuscado.includes(nombreBarbero);
        });

        if (!barbero) {
          const nombresDisponibles = barberos?.map(b => `*${b.name}*`).join(', ') || 'ninguno';
          await chakraSendSession(from, 
            `No encontré al barbero "${matchNombreHora.nombre}" 🤔\n` +
            `Nuestros barberos son: ${nombresDisponibles}\n\n` +
            `Revisa el nombre o solo manda la hora para que te asignemos uno.\n` +
            `Ej: *15:00* o *3 pm*`
          );
          return;
        }

        const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const esHoy = state.fecha === nowMX.toISOString().slice(0, 10);
        const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;
        
        const slotsLibres = await getSlotsLibres(barbero.id, state.fecha, horaActual);
        if (!slotsLibres.includes(horaSolicitada)) {
          await chakraSendSession(from, `😔 Ese horario ya no está disponible con *${barbero.name}*.\nEscribe *hola* para ver los horarios actualizados.`);
          delete conversationState[from];
          return;
        }

        const digits10 = from.replace(/^52/, '').slice(-10);

        conversationState[from] = {
          step: 'confirmando',
          barberoId: barbero.id, barberoName: barbero.name,
          fecha: state.fecha, fechaLabel: state.fechaLabel,
          hora: horaSolicitada,
          horaSeleccionada: horaSolicitada,
          clientPhone: state.clientPhone || digits10,
          serviceName: servicioSolicitado,
        };

        await chakraSendSession(from,
          `📋 *Resumen de tu cita:*\n\n` +
          `👤 Barbero: *${barbero.name}*\n` +
          `📅 Fecha: *${state.fechaLabel}*\n` +
          `🕐 Hora: *${horaSolicitada}*\n` +
          `` +
          `¿Confirmas?\n✅ Responde *SÍ* para agendar\n❌ Responde *NO* para cancelar`
        );
        return;
      }

      // ── Solo mandó el nombre del barbero (sin hora) → usar la hora ya seleccionada ──
      if (!matchNombreHora && !soloHoraMatch && state.horaSeleccionada) {
        const nombreBuscado = normalizarTexto(text);
        const { data: barberosSolo } = await supabase.from('barbers').select('id, name').eq('active', true);
        const barberoSolo = barberosSolo?.find(b => {
          const nombreBarbero = normalizarTexto(b.name);
          return nombreBarbero.includes(nombreBuscado) || nombreBuscado.includes(nombreBarbero);
        });

        if (barberoSolo) {
          const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
          const esHoy = state.fecha === nowMX.toISOString().slice(0, 10);
          const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;

          const slotsLibres = await getSlotsLibres(barberoSolo.id, state.fecha, horaActual);
          if (!slotsLibres.includes(state.horaSeleccionada)) {
            await chakraSendSession(from, `😔 Ese horario ya no está disponible con *${barberoSolo.name}*.\n¿Quieres intentar otra hora u otro barbero? Dime cuál, o escribe *cancelar*.`);
            return;
          }

          const servicioSolicitado = extraerServicioDelMensaje(text) || state.serviceName || 'Corte Premium';
          const digits10 = from.replace(/^52/, '').slice(-10);

          conversationState[from] = {
            step: 'confirmando',
            barberoId: barberoSolo.id, barberoName: barberoSolo.name,
            fecha: state.fecha, fechaLabel: state.fechaLabel,
            hora: state.horaSeleccionada,
            horaSeleccionada: state.horaSeleccionada,
            clientPhone: state.clientPhone || digits10,
            serviceName: servicioSolicitado,
          };

          await chakraSendSession(from,
            `📋 *Resumen de tu cita:*\n\n` +
            `👤 Barbero: *${barberoSolo.name}*\n` +
            `📅 Fecha: *${state.fechaLabel}*\n` +
            `🕐 Hora: *${state.horaSeleccionada}*\n` +
            `` +
            `¿Confirmas?\n✅ Responde *SÍ* para agendar\n❌ Responde *NO* para cancelar`
          );
          return;
        }
      }

      if (soloHoraMatch) {
        let hour = parseInt(soloHoraMatch[1], 10);
        const minutes = soloHoraMatch[2] ? parseInt(soloHoraMatch[2], 10) : 0;
        const meridiano = soloHoraMatch[3]?.toLowerCase().replace(/\./g, '').replace('hrs', '').trim() || '';
        
        if (meridiano === 'pm' && hour < 12) hour += 12;
        if (meridiano === 'am' && hour === 12) hour = 0;
        if (!meridiano && hour >= 1 && hour <= 9) hour += 12;
        
        const horaSolicitada = `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

        if (!getSlotsDelDia(state.fecha).includes(horaSolicitada)) {
          await chakraSendSession(from,
            `😅 La hora *${horaSolicitada}* no está en nuestro horario (${getHorarioLabel(state.fecha)}).\nDime otra hora o escribe *cancelar*.`
          );
          return;
        }

        const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const esHoy = state.fecha === nowMX.toISOString().slice(0, 10);
        const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;
        
        if (esHoy) {
          const [h, m] = horaSolicitada.split(':').map(Number);
          if (h * 60 + m <= horaActual) {
            await chakraSendSession(from, `😅 La hora *${horaSolicitada}* ya pasó. Por favor elige una hora futura.`);
            return;
          }
        }

        const { data: barberos } = await supabase.from('barbers').select('id, name').eq('active', true);
        const disponibles = [];
        for (const barbero of (barberos || [])) {
          const slotsLibres = await getSlotsLibres(barbero.id, state.fecha, horaActual);
          if (slotsLibres.includes(horaSolicitada)) disponibles.push(barbero);
        }

        if (!disponibles.length) {
          await chakraSendSession(from,
            `😔 A las *${horaSolicitada}* no tenemos a nadie libre el *${state.fechaLabel}*.\n` +
            `¿Quieres intentar otra hora? Dímela, o escribe *cancelar*.`
          );
          return;
        }

        const servicioSolicitado = extraerServicioDelMensaje(text) || state.serviceName || 'Corte Premium';
        const barberoAsignado = disponibles[Math.floor(Math.random() * disponibles.length)];
        const digits10 = from.replace(/^52/, '').slice(-10);

        conversationState[from] = {
          step: 'confirmando',
          barberoId: barberoAsignado.id, barberoName: barberoAsignado.name,
          fecha: state.fecha, fechaLabel: state.fechaLabel,
          hora: horaSolicitada,
          horaSeleccionada: horaSolicitada,
          clientPhone: state.clientPhone || digits10,
          serviceName: servicioSolicitado,
        };

        await chakraSendSession(from,
          `✅ ¡Perfecto! Te asignamos con *${barberoAsignado.name}* a las *${horaSolicitada}* el *${state.fechaLabel}*.\n\n` +
          `📋 *Resumen de tu cita:*\n👤 Barbero: *${barberoAsignado.name}*\n📅 Fecha: *${state.fechaLabel}*\n🕐 Hora: *${horaSolicitada}*\n` +
          `¿Confirmas?\n✅ Responde *SÍ* para agendar\n❌ Responde *NO* para cancelar`
        );
        return;
      }

      await chakraSendSession(from, `No entendí tu selección 😅\nEscríbeme así:\n- *Nombre del barbero* + hora: _Raúl 15:00_\n- O solo la hora: _15:00_ o _3 pm_\n\nO escribe *cancelar* para salir.`);
      return;
    }

    // ── Confirmando ────────────────────────────────────────────────────────────
    if (state?.step === 'confirmando') {
      const confirma = ['sí', 'si', 'yes', 'confirmo', 'ok', '1', '✅'].some(k => textLower.includes(k));
      const cancela  = ['no', 'cancelar', 'cancel', '2'].some(k => textLower.includes(k));

      // ── Quiere cambiar de barbero (solo si lo pide) — mantiene la misma hora ──
      if (!confirma && !cancela && state.hora) {
        const nombreBuscadoCambio = normalizarTexto(text);
        const { data: barberosCambio } = await supabase.from('barbers').select('id, name').eq('active', true);
        const barberoCambio = barberosCambio?.find(b => {
          const nombreBarbero = normalizarTexto(b.name);
          return (nombreBarbero.includes(nombreBuscadoCambio) || nombreBuscadoCambio.includes(nombreBarbero)) && nombreBarbero !== normalizarTexto(state.barberoName || '');
        });

        if (barberoCambio) {
          const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
          const esHoy = state.fecha === nowMX.toISOString().slice(0, 10);
          const horaActual = esHoy ? nowMX.getHours() * 60 + nowMX.getMinutes() : null;

          const slotsLibresCambio = await getSlotsLibres(barberoCambio.id, state.fecha, horaActual);
          if (!slotsLibresCambio.includes(state.hora)) {
            await chakraSendSession(from, `😔 *${barberoCambio.name}* no tiene libre las *${state.hora}* el *${state.fechaLabel}*.\n¿Quieres intentar otro barbero, otra hora, o mantener a *${state.barberoName}*?`);
            return;
          }

          conversationState[from] = {
            ...state,
            step: 'confirmando',
            barberoId: barberoCambio.id,
            barberoName: barberoCambio.name,
          };

          await chakraSendSession(from,
            `📋 *Resumen de tu cita:*\n\n` +
            `👤 Barbero: *${barberoCambio.name}*\n` +
            `📅 Fecha: *${state.fechaLabel}*\n` +
            `🕐 Hora: *${state.hora}*\n` +
            `` +
            `¿Confirmas?\n✅ Responde *SÍ* para agendar\n❌ Responde *NO* para cancelar`
          );
          return;
        }
      }

      if (confirma) {
        // ── Paso 1: Obtener o crear el cliente ──────────────────────────────
        const digits10 = from.replace(/^52/, '').slice(-10);
        const cliente = await obtenerOCrearCliente(digits10, state.clientName || null);

        if (!cliente) {
          await chakraSendSession(from, `¡Gracias! 🙌 Ya casi tenemos lista tu cita — en un momento el equipo te la confirma personalmente.`);
          await alertarEquipoManual({
            cliente: `${state.clientName || '(sin nombre)'} (${digits10})`,
            fechaHora: `${state.fecha} ${state.hora}`,
            barbero: state.barberoName,
            detalle: `No se pudo registrar al cliente al agendar por WhatsApp. Servicio: ${state.serviceName}`,
          });
          delete conversationState[from];
          return;
        }

        // ── Paso 2: Obtener o crear el servicio ─────────────────────────────
        const servicio = await obtenerOCrearServicio(state.serviceName || 'Corte Premium');

        if (!servicio) {
          await chakraSendSession(from, `¡Gracias! 🙌 Ya casi tenemos lista tu cita — en un momento el equipo te la confirma personalmente.`);
          await alertarEquipoManual({
            cliente: `${cliente.name} (${cliente.phone})`,
            fechaHora: `${state.fecha} ${state.hora}`,
            barbero: state.barberoName,
            detalle: `No se pudo obtener/crear el servicio "${state.serviceName}" al agendar por WhatsApp.`,
          });
          delete conversationState[from];
          return;
        }

        // ── Paso 3: Crear la cita ────────────────────────────────────────────
        const endTime = (() => {
          const [h, m] = state.hora.split(':').map(Number);
          const end = h * 60 + m + 60;
          return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
        })();

        const precio = servicio.price || 350;

        const citaData = {
          client_id: cliente.id,
          client_name: cliente.name,
          client_phone: cliente.phone,
          barber_id: state.barberoId,
          barber_name: state.barberoName,
          service_id: servicio.id,
          service_name: servicio.name,
          date: state.fecha,
          time: state.hora,
          status: 'pendiente',
          price: precio,
          whatsapp_sent: true,
          reminder_sent: false,
          duration_minutes: servicio.duration || 60,
          end_time: endTime,
          notes: `Agendado por WhatsApp. Servicio: ${servicio.name}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        console.log('📝 Creando cita con datos:', JSON.stringify(citaData, null, 2));

        const { error } = await supabase
          .from('appointments')
          .insert([citaData]);

        delete conversationState[from];

        if (error) {
          console.error('❌ Error creando cita desde WhatsApp:', error.message);
          console.error('❌ Datos que causaron error:', JSON.stringify(citaData, null, 2));
          await chakraSendSession(from, `¡Gracias! 🙌 Ya casi tenemos lista tu cita — en un momento el equipo te la confirma personalmente.`);
          await alertarEquipoManual({
            cliente: `${cliente.name} (${cliente.phone})`,
            fechaHora: `${state.fecha} ${state.hora}`,
            barbero: state.barberoName,
            detalle: `No se pudo crear la cita (servicio: ${servicio.name}) al agendar por WhatsApp. Error: ${error.message}`,
          });
          return;
        }

        console.log(`✅ Cita agendada vía WhatsApp: ${cliente.name} con ${state.barberoName} el ${state.fecha} a las ${state.hora}`);
        await chakraSendSession(from,
          `✅ ¡Listo! Tu cita quedó agendada:\n\n` +
          `👤 Cliente: *${cliente.name}*\n` +
          `👤 Barbero: *${state.barberoName}*\n` +
          `📅 Fecha: *${state.fechaLabel}*\n` +
          `🕐 Hora: *${state.hora}*\n\n` +
          `Te esperamos en Imperium Caesar's Barber Club 💈`
        );
      } else if (cancela) {
        delete conversationState[from];
        await chakraSendSession(from, `Entendido, cancelé el proceso. Escríbeme *hola* cuando quieras agendar 👍`);
      } else {
        // El cliente no respondió SÍ/NO — puede que esté pidiendo otra fecha
        // (ej. "Prefiero viernes 3 de julio"). Si detectamos una fecha nueva,
        // le mostramos disponibilidad para esa fecha en vez de solo insistir.
        const fechaPedida = parsearFechaPedida(text);
        if (fechaPedida) {
          const fechaLabel = formatDateMX(fechaPedida);
          const yaAtendido = await confirmarHorarioPuntual(from, text, fechaPedida, fechaLabel, state);
          if (!yaAtendido) {
            await mostrarDisponibilidadEnFecha(from, fechaPedida, `¡Claro! Cambiemos tu cita.`);
          }
          return;
        }
        await chakraSendSession(from, `Responde *SÍ* para confirmar tu cita o *NO* para cancelar.\n\nSi prefieres otra fecha, dime cuál (ej. _viernes 3 de julio_) y te muestro los horarios disponibles.`);
      }
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // RESPUESTAS GENERALES
    // ══════════════════════════════════════════════════════════════════════════

    // ── Preguntas sobre precios ──────────────────────────────────────────────
    const esPreguntaPrecio = [
      'precio', 'precios', 'cuesta', 'valor', 'tarifa', 'cuánto', 'cuanto', 
      'costo', 'costos', 'presupuesto', '$', 'pesos', 'precio corte',
      'precio barba', 'precio afeitado', 'cuanto cuesta', 'qué precio',
      'lista de precios', 'menú de precios', 'carta de precios'
    ].some(k => textLower.includes(k));

    if (esPreguntaPrecio) {
      const mensajePrecios = await buildPreciosMsg();
      await chakraSendSession(from, mensajePrecios);
      return;
    }

    // ── Encuesta pendiente ────────────────────────────────────────────────────
    const encuestaPendiente = await getEncuestaPendiente(from);
    if (encuestaPendiente) {
      const { client: clienteEncuesta } = await getClienteYCita(from);
      const firstNameEncuesta = clienteEncuesta?.name?.split(' ')[0] || 'amigo';
      await supabase.from('appointments').update({
        survey_feedback: text,
        survey_responded_at: new Date().toISOString(),
      }).eq('id', encuestaPendiente.id);
      await chakraSendSession(from,
        `¡Muchas gracias por contarnos, ${firstNameEncuesta}! 🙏 Tomamos en cuenta tu comentario para seguir mejorando.`
      );
      console.log(`⭐ Encuesta respondida: cita ${encuestaPendiente.id}`);
      return;
    }

    // ── Gracias ───────────────────────────────────────────────────────────────
    const esGracias = ['gracias', 'muchas gracias', 'thank', 'thanks', '🙏'].some(k => textLower.includes(k));
    if (esGracias) {
      const { client } = await getClienteYCita(from);
      const nombreGracias = client?.name?.split(' ')[0] || '';
      await chakraSendSession(from, `¡Con gusto${nombreGracias ? ' ' + nombreGracias : ''}! 😊 Que tengas excelente día. 💈`);
      return;
    }

    const esHola    = ['hola', 'hello', 'hi', 'buenas', 'buenos', 'buen dia', 'buen día', 'hey'].some(k => textLower.includes(k));
    const pareceHoraCita = /\d{1,2}(:\d{2})?\s*(am|pm|a\.?m\.?|p\.?m\.?|hrs?|horas?)\b/i.test(text)
      || /\b\d{1,2}:\d{2}\b/.test(text);
    const pareceFechaCita = !state && !!parsearFechaPedida(text);
    const esAgendar = ['agendar', 'cita', 'appointment', 'reservar', 'turno', 'espacio', 'disponibilidad'].some(k => textLower.includes(k))
      || pareceHoraCita || pareceFechaCita;
    const quiereCita = ['sí', 'si', 'yes', 'claro', 'por favor', 'quiero', 'reserva', 'reservar', 'aparta', 'apartar', 'anota', 'anotar'].some(k => textLower.includes(k));
    const esPrecio  = ['precio', 'precios', 'cuanto cuesta', 'cuánto cuesta', 'costo', 'servicio', 'servicios'].some(k => textLower.includes(k));

    // ── Mensaje largo o pregunta compleja → derivar a humano ─────────────────
    // (excepto si ya trae una intención reconocible: saludo, agendar o precios/servicios)
    const esMensajeLargo   = text.length > 80;
    const esPreguntaComple = (text.match(/\?/g) || []).length > 1 || (text.length > 50 && text.includes('?'));
    const tieneIntencionConocida = esHola || esAgendar || quiereCita || esPrecio || esReagendar;
    if ((esMensajeLargo || esPreguntaComple) && !tieneIntencionConocida) {
      await chakraSendSession(from, `Hola 👋 Recibimos tu mensaje. Un momento, pronto te atendemos personalmente. 💈`);
      return;
    }

    // ── Si está esperando confirmación de si quiere cita ─────────────────────
    if (state?.step === 'esperando_confirmacion_cita') {
      const fechaPedida = parsearFechaPedida(text);

      if (fechaPedida) {
        await mostrarDisponibilidadEnFecha(from, fechaPedida, '¡Perfecto!');
      } else if (quiereCita || esAgendar) {
        await prepararFechaYGuardarState(from);
        const disponibilidadMsg = await buildDisponibilidadMsg();
        await chakraSendSession(from, `¡Perfecto! 💈 Aquí tienes los horarios disponibles:\n\n${disponibilidadMsg}`);
      } else {
        delete conversationState[from];
        await chakraSendSession(from, `¡Claro! Si en algún momento deseas vivir la experiencia IMPERIUM, aquí estaremos. 🫡`);
      }
      return;
    }

    // ── Hola / información general → mensaje de bienvenida ───────────────────
    if (esHola && !esAgendar) {
      conversationState[from] = { step: 'esperando_confirmacion_cita' };
      await chakraSendSession(from,
        `¡Hola! Gracias por contactar a *IMPERIUM CAESARS Barber Club*. 💈\n\n` +
        `Te ayudamos a proyectar una mejor imagen a través de una experiencia de cuidado personal diseñada para caballeros, que incluye *asesoría de imagen*, *lavado de cabello*, *bebida de cortesía* y nuestras exclusivas *Manos del Emperador*.\n\n` +
        `¿Te reservo algún espacio para vivir la experiencia IMPERIUM?`
      );
      return;
    }

    // ── Quiere precios/servicios Y agendar en el mismo mensaje ────────────────
    // (ej. "quiero conocer sus servicios y agendar cita") → primero precios,
    // luego horarios, en vez de saltar directo a horarios.
    if (esAgendar && esPrecio) {
      const mensajePrecios = await buildPreciosMsg(false);
      await chakraSendSession(from, mensajePrecios);

      // Si ya mencionó una hora puntual (ej. "quiero precios y agendar a las 15:00"),
      // revisar esa hora en vez de solo mostrar la disponibilidad genérica.
      const fechaMencionadaPrecio = parsearFechaPedida(text);
      const fechaParaHoraPrecio = fechaMencionadaPrecio || new Date(Date.now() - 6 * 60 * 60 * 1000);
      const yaAtendidoPrecio = await confirmarHorarioPuntual(from, text, fechaParaHoraPrecio, formatDateMX(fechaParaHoraPrecio), null);
      if (yaAtendidoPrecio) return;

      await prepararFechaYGuardarState(from);
      const disponibilidadMsg = await buildDisponibilidadMsg();
      await chakraSendSession(from, `¿Te reservo un espacio? Aquí tienes los horarios disponibles:\n\n${disponibilidadMsg}`);
      return;
    }

    // ── Quiere agendar directamente ───────────────────────────────────────────
    if (esAgendar) {
      // Si el mensaje ya trae una hora puntual (ej. "¿Tendrán espacio a las 15:00?"),
      // revisar esa hora exacta (en la fecha mencionada, o "hoy" si no mencionó fecha)
      // en vez de saltar directo a mostrar la disponibilidad genérica del primer día
      // con espacio — eso era lo que causaba que se ofreciera "mañana" aunque hoy sí
      // hubiera hueco a esa hora.
      const fechaMencionada = parsearFechaPedida(text);
      const fechaParaHora = fechaMencionada || new Date(Date.now() - 6 * 60 * 60 * 1000);
      const yaAtendido = await confirmarHorarioPuntual(from, text, fechaParaHora, formatDateMX(fechaParaHora), null);
      if (yaAtendido) return;

      await prepararFechaYGuardarState(from);
      const disponibilidadMsg = await buildDisponibilidadMsg();
      await chakraSendSession(from, `¡Hola! 👋 Bienvenido a *Imperium Caesar's Barber Club* 💈\n\n${disponibilidadMsg}`);
      return;
    }

    // ── Confirmación / cancelación de cita existente ──────────────────────────
    const { client, cita } = await getClienteYCita(from);
    const firstName = client?.name?.split(' ')[0] || 'amigo';

    if (!client) {
      await chakraSendSession(from, `¡Hola! 👋 No encontramos tu número en nuestro sistema.\nEscribe *hola* para ver horarios disponibles. 💈`);
      return;
    }

    const esConfirmacion = ['sí, confirmo', 'sí', 'si', 'confirmo', 'confirmar', '1', 'yes', 'ok', '✅'].some(k => textLower.includes(k));
    // ✅ 'no' suelto eliminado — usamos match exacto para evitar falsos positivos
    // como "no nada mas", "no gracias", "no me llames", etc.
    const esCancelacion = (
      textLower === 'no' ||
      ['no puedo asistir', 'cancelar', 'cancelo', 'cancelación', 'cancel'].some(k => textLower.includes(k))
    );

    // ── Despedida amable ("no nada", "no gracias", "no nada mas") ────────────
    // Detectar antes de llegar a cancelación de cita
    const esDespedida = ['no nada', 'no gracias', 'nada mas', 'nada más', 'estoy bien', 'todo bien', 'ya es todo', 'eso es todo', 'hasta luego', 'bye', 'adiós', 'adios'].some(k => textLower.includes(k));
    if (esDespedida) {
      const { client: clientDespedida } = await getClienteYCita(from);
      const nameDespedida = clientDespedida?.name?.split(' ')[0] || '';
      await chakraSendSession(from, `¡Que tengas un excelente día${nameDespedida ? ' ' + nameDespedida : ''}! 😊 Cuando nos necesites aquí estaremos. 💈`);
      return;
    }

    if (!cita) {
      await chakraSendSession(from, `Hola ${firstName} 👋 No tienes citas próximas.\n\nEscribe *hola* para ver horarios y agendar una cita. 💈`);
      return;
    }

    if (esConfirmacion && cita.status !== 'confirmada') {
      await supabase.from('appointments').update({ status: 'confirmada' }).eq('id', cita.id);
      await chakraSendSession(from, `✅ ¡Perfecto ${firstName}! Tu cita del *${cita.date}* a las *${cita.time}* con *${cita.barber_name ?? 'tu barbero'}* queda confirmada. ¡Te esperamos! 💈`);
      console.log(`✅ Cita ${cita.id} confirmada para ${client.name}`);
      return;
    }

    if (esCancelacion) {
      await supabase.from('appointments').update({ status: 'cancelada' }).eq('id', cita.id);
      await chakraSendSession(from, `❌ Entendido ${firstName}, tu cita del *${cita.date}* ha sido cancelada. Si quieres reagendar escribe *hola* cuando gustes 🙌`);
      console.log(`❌ Cita ${cita.id} cancelada para ${client.name}`);
      return;
    }

    await chakraSendSession(from,
      `Hola ${firstName} 👋 Tienes una cita el *${cita.date}* a las *${cita.time}*.\n\nResponde:\n✅ *SÍ* para confirmar\n❌ *CANCELAR* para cancelar\n🔁 *REAGENDAR* para cambiarla de día u hora\n\nO escribe *hola* para ver horarios y agendar otra cita.`
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
  try {
    await chakraSendTemplate(phone, 'barberia_recordatorio_24h', variables);
    res.json({ success: true, variablesUsadas: variables });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, detail: err.response?.data ?? null });
  }
});

app.get('/test-disponibilidad', async (req, res) => {
  const msg = await buildDisponibilidadMsg();
  res.json({ mensaje: msg });
});

app.post('/test-send-image', async (req, res) => {
  try {
    const { to, image, caption } = req.body;
    if (!to || !image) return res.status(400).json({ success: false, error: 'Faltan to e image (base64)' });

    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const sizeMB = (imageBuffer.length / 1024 / 1024).toFixed(2);
    console.log(`🖼️ Imagen recibida — tamaño: ${sizeMB} MB`);

    if (imageBuffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: `Imagen demasiado grande: ${sizeMB} MB (máx 5 MB)` });
    }

    console.log('📤 Subiendo imagen a Chakra...');
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', imageBuffer, { filename: 'ticket.jpg', contentType: 'image/jpeg' });
    form.append('filename', 'ticket.jpg');

    const uploadUrl = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/upload-public-media`;
    let uploadRes;
    try {
      uploadRes = await axios.post(uploadUrl, form, {
        headers: { ...chakraHeaders(), ...form.getHeaders() },
        timeout: 30000,
      });
      console.log('✅ Upload response:', JSON.stringify(uploadRes.data));
    } catch (uploadErr) {
      console.error('❌ Upload falló:', JSON.stringify(uploadErr.response?.data ?? uploadErr.message));
      return res.status(500).json({
        success: false,
        step: 'upload',
        error: uploadErr.response?.data ?? uploadErr.message,
      });
    }

    const publicUrl = uploadRes.data?._data?.publicMediaUrl;
    if (!publicUrl) {
      return res.status(500).json({
        success: false,
        step: 'upload',
        error: 'No se obtuvo publicMediaUrl',
        rawResponse: uploadRes.data,
      });
    }

    console.log(`🔗 URL pública: ${publicUrl}`);

    console.log(`📱 Enviando imagen a ${normalizePhone(to)}...`);
    const msgUrl = `${CHAKRA_API_URL}/v1/ext/plugin/whatsapp/${CHAKRA_PLUGIN_ID}/api/${WA_API_VERSION}/${CHAKRA_PHONE_ID}/messages`;
    let msgRes;
    try {
      msgRes = await axios.post(msgUrl, {
        messaging_product: 'whatsapp',
        to: normalizePhone(to),
        type: 'image',
        image: { link: publicUrl, caption: caption || '🎫 Ticket de venta' },
      }, { headers: chakraHeaders(), timeout: 15000 });
      console.log('✅ Mensaje enviado:', JSON.stringify(msgRes.data));
    } catch (msgErr) {
      console.error('❌ Envío falló:', JSON.stringify(msgErr.response?.data ?? msgErr.message));
      return res.status(500).json({
        success: false,
        step: 'send',
        publicUrl,
        error: msgErr.response?.data ?? msgErr.message,
      });
    }

    return res.json({
      success: true,
      sizeMB,
      publicUrl,
      wamid: msgRes.data?.messages?.[0]?.id,
    });

  } catch (err) {
    console.error('❌ test-send-image error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/test-encuestas', async (req, res) => {
  const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const yesterday = new Date(nowMX);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const { data: citas, error } = await supabase
    .from('appointments')
    .select('id, date, status, client_name, client_phone, survey_sent')
    .eq('date', yesterdayStr);
  res.json({
    serverTime: new Date().toISOString(),
    ayerBuscado: yesterdayStr,
    citasEncontradas: citas?.length ?? 0,
    pendientesDeEncuesta: citas?.filter(c => ['pendiente','confirmada'].includes(c.status) && !c.survey_sent).length ?? 0,
    citas: citas ?? [],
    error: error?.message ?? null,
  });
});

app.get('/run-reminders', async (req, res) => {
  console.log('🔔 Recordatorios disparados externamente');
  enviarRecordatorios('EXTERNO').catch(console.error);
  res.json({ success: true, message: 'Recordatorios iniciados' });
});

app.get('/run-encuestas', async (req, res) => {
  console.log('⭐ Encuestas disparadas externamente');
  enviarEncuestas('EXTERNO').catch(console.error);
  res.json({ success: true, message: 'Encuestas iniciadas' });
});

app.get('/test-send', async (req, res) => {
  const { to, template = 'cliente_en_riesgo_reenganche', vars = 'Cliente' } = req.query;
  if (!to) return res.status(400).json({ success: false, error: 'Falta ?to=52XXXXXXXXXX' });
  const variables = String(vars).split(',').map(v => v.trim());
  try {
    await chakraSendTemplate(to, template, variables);
    res.json({ success: true, to: normalizePhone(to), template, variables });
  } catch (error) {
    const status = error.response?.status ?? 500;
    const metaError = error.response?.data?.error;
    const errMsg = metaError?.message || error.response?.data?._errors?.join('; ') || error.message;
    res.status(status).json({ success: false, error: errMsg });
  }
});

// ─── Recordatorios 24h ───────────────────────────────────────────────────────

async function enviarRecordatorios(etiqueta = '') {
  const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const tomorrow = new Date(nowMX);
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

    const optoPorNoMensajes = await clienteOptoPorNoMensajes(cita.client_phone);
    if (optoPorNoMensajes) {
      console.log(`🚫 ${cita.client_name} desactivó los mensajes automatizados, se omite el recordatorio`);
      continue;
    }

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

// ─── Encuestas post-servicio ──────────────────────────────────────────────────

async function enviarEncuestas(etiqueta = '') {
  const nowMX = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const yesterday = new Date(nowMX);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  console.log(`⭐ [${etiqueta}] Enviando encuestas para citas del ${yesterdayStr}...`);

  const { data: citas, error } = await supabase
    .from('appointments')
    .select('id, date, status, client_name, client_phone, survey_sent')
    .eq('date', yesterdayStr)
    .in('status', ['pendiente', 'confirmada', 'completada'])
    .or('survey_sent.is.null,survey_sent.eq.false');

  if (error) { console.error(`❌ [${etiqueta}] Error:`, error.message); return; }
  if (!citas?.length) { console.log(`ℹ️ [${etiqueta}] Sin citas pendientes de encuesta`); return; }

  console.log(`📋 [${etiqueta}] ${citas.length} cita(s) pendientes de encuesta`);

  // Agrupar por cliente (teléfono): si tuvo varias citas el mismo día, solo se
  // manda UNA encuesta, usando la cita más reciente como referencia.
  const citasPorCliente = new Map();
  for (const cita of citas) {
    if (!cita.client_phone) { console.warn(`⚠️ Cita ${cita.id} sin teléfono`); continue; }
    const grupo = citasPorCliente.get(cita.client_phone) || [];
    grupo.push(cita);
    citasPorCliente.set(cita.client_phone, grupo);
  }

  for (const [telefono, grupo] of citasPorCliente) {
    const citaReferencia = grupo[grupo.length - 1];
    try {
      await chakraSendTemplate(telefono, 'barberia_encuesta_servicio', [
        citaReferencia.client_name?.split(' ')[0] ?? 'Cliente',
        formatFechaCorta(citaReferencia.date),
      ]);
      // Marcar TODAS las citas del cliente ese día como enviadas, aunque solo
      // se haya mandado una plantilla, para que ninguna quede pendiente y
      // dispare un envío duplicado en la próxima corrida del cron.
      const idsDelGrupo = grupo.map(c => c.id);
      await supabase.from('appointments').update({
        survey_sent: true,
        survey_sent_at: new Date().toISOString(),
      }).in('id', idsDelGrupo);
      console.log(`✅ Encuesta enviada a ${citaReferencia.client_name} (${telefono}) — ${grupo.length} cita(s) agrupada(s)`);
      await new Promise(r => setTimeout(r, 1000));
    } catch (sendErr) {
      console.error(`❌ Error enviando encuesta a ${citaReferencia.client_name}:`, sendErr.response?.data || sendErr.message);
    }
  }
}

// ─── Crons ────────────────────────────────────────────────────────────────────

cron.schedule('0 16 * * *', () => {
  console.log('🌅 Cron matutino disparado');
  enviarRecordatorios('MAÑANA');
});

cron.schedule('0 23 * * *', () => {
  console.log('🌙 Cron nocturno disparado');
  enviarRecordatorios('NOCHE');
});

cron.schedule('0 17 * * *', () => {
  console.log('⭐ Cron de encuestas disparado');
  enviarEncuestas('ENCUESTA');
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