const PP_KEY = "0HNndAwG6NIXcksD1kRxHVHMgUtDi8GqgMfMQrymleH8HluAdA1ZRAl2jG3B";
const PP_VENDOR = "531";
const PP_BASE = "https://palmpesa.drmlelwa.co.tz/api";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

const TIMEOUT_MINUTES = 60;
const BUMP_INTERVAL_MINUTES = 5;
const MAX_PAID_GAP = 15;
const ENTRY_FEE = 20000;

function pad(n) { return String(n).padStart(3, "0"); }

// ===== DB HELPERS =====
async function getTickets(env) {
  try { const d = await env.DB.get("tickets"); return d ? JSON.parse(d) : []; }
  catch(e) { return []; }
}
async function saveTickets(env, tickets) {
  await env.DB.put("tickets", JSON.stringify(tickets));
}
async function getCounter(env) {
  try { const c = await env.DB.get("counter"); return c ? parseInt(c) : 0; }
  catch(e) { return 0; }
}
async function incCounter(env) {
  const c = await getCounter(env) + 1;
  await env.DB.put("counter", String(c));
  return c;
}

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: CORS });
}

// ===== PHONE FORMAT =====
function formatPhone(phone) {
  const clean = phone.replace(/\s/g, "").replace(/^\+/, "");
  if (clean.startsWith("0")) return "255" + clean.substring(1);
  if (clean.startsWith("255")) return clean;
  return clean;
}

// ===== QUEUE LOGIC =====
function now() { return new Date().toISOString(); }

function minutesSince(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / 60000;
}

// Check if ticket is expired (60 min unpaid OR 15 paid tickets after it)
function isExpired(ticket, allTickets) {
  if (ticket.status !== "pending") return false;
  // Rule 1: 60 minutes without payment
  if (minutesSince(ticket.created_at) >= TIMEOUT_MINUTES) return true;
  // Rule 2: 15 paid tickets came after
  const paidAfter = allTickets.filter(t => 
    t.status === "active" && t.queue_position > ticket.queue_position
  ).length;
  if (paidAfter >= MAX_PAID_GAP) return true;
  return false;
}

// Check if ticket should be bumped (every 5 min unpaid)
function shouldBump(ticket) {
  if (ticket.status !== "pending") return false;
  const lastBump = ticket.last_bumped_at || ticket.created_at;
  return minutesSince(lastBump) >= BUMP_INTERVAL_MINUTES;
}

// Reassign queue positions: paid first, then pending (by creation time), expired removed
async function reassignQueue(env) {
  let tickets = await getTickets(env);
  let changed = false;

  // Mark expired tickets
  for (const t of tickets) {
    if (t.status === "pending" && isExpired(t, tickets)) {
      t.status = "expired";
      t.expired_at = now();
      changed = true;
    }
  }

  // Sort: active (paid) first by queue_position, then pending by creation time
  const active = tickets.filter(t => t.status === "active").sort((a, b) => a.queue_position - b.queue_position);
  const pending = tickets.filter(t => t.status === "pending").sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const others = tickets.filter(t => t.status !== "active" && t.status !== "pending");

  // Reassign positions: paid keep relative order, pending get pushed after
  let pos = 1;
  for (const t of active) { t.queue_position = pos++; changed = true; }
  for (const t of pending) { t.queue_position = pos++; changed = true; }

  tickets = [...active, ...pending, ...others];
  if (changed) await saveTickets(env, tickets);
  return tickets;
}

// Bump unpaid holder: reassign their number to the end
async function bumpTicket(env, ticketNumber) {
  let tickets = await getTickets(env);
  const ticket = tickets.find(t => t.number === ticketNumber && t.status === "pending");
  if (!ticket) return null;

  const counter = await getCounter(env);
  const newNumber = "E-" + pad(counter + 1);
  await env.DB.put("counter", String(counter + 1));

  ticket.number = newNumber;
  ticket.original_number = ticket.original_number || ticketNumber;
  ticket.last_bumped_at = now();
  ticket.bump_count = (ticket.bump_count || 0) + 1;

  await saveTickets(env, tickets);
  return ticket;
}

// ===== PALMPESA =====
async function ppInitiate(data, callbackUrl) {
  const phone = formatPhone(data.phone);
  const res = await fetch(PP_BASE + "/pay-via-mobile", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PP_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      user_id: PP_VENDOR,
      name: data.name,
      email: data.email || "noemail@example.com",
      phone: phone,
      amount: data.amount,
      transaction_id: data.txId,
      address: "Dar es Salaam",
      postcode: "11111",
      buyer_uuid: 1,
      callback_url: callbackUrl,
    }),
  });
  return res.json();
}

async function ppCheckOrder(orderId) {
  const res = await fetch(PP_BASE + "/order-status", {
    method: "POST",
    headers: { "Authorization": `Bearer ${PP_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId }),
  });
  return res.json();
}

// ===== MAIN HANDLER =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const host = url.hostname;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    let body = {};
    if (method === "POST") { try { body = await request.json(); } catch {} }

    const parts = path.replace(/^\/api\//, "").split("/");
    const base = parts[0];
    const param = parts[1] ? parts[1].toUpperCase() : null;

    // Reassign queue on every request (keeps positions fresh)
    let tickets = await reassignQueue(env);

    // --- HEALTH ---
    if (path === "/api/health" || path === "/health" || path === "/") {
      return json({ status: "ok", palmPesa: true, vendor: PP_VENDOR, fee: ENTRY_FEE });
    }

    // --- QUEUE STATS ---
    if (path === "/api/queue") {
      const active = tickets.filter(t => t.status === "active");
      const used = tickets.filter(t => t.status === "used");
      const pending = tickets.filter(t => t.status === "pending");
      const expired = tickets.filter(t => t.status === "expired");
      return json({
        total: tickets.length,
        active: active.length,
        used: used.length,
        pending: pending.length,
        expired: expired.length,
        waiting: active.length,
        last_number: await getCounter(env),
        currently_serving: used.length,
        entry_fee: ENTRY_FEE,
        timeout_minutes: TIMEOUT_MINUTES,
        bump_interval_minutes: BUMP_INTERVAL_MINUTES,
        max_paid_gap: MAX_PAID_GAP,
      });
    }

    // --- CREATE TICKET ---
    if (path === "/api/ticket" && method === "POST") {
      const { name, phone, email } = body;
      if (!name || !phone) return json({ error: "Name and phone required" }, 400);

      // Reassign queue first to get fresh positions
      tickets = await reassignQueue(env);

      const counter = await incCounter(env);
      const number = "E-" + pad(counter);

      tickets.push({
        id: counter, number, name,
        phone: phone.replace(/^\+/, ""),
        email: email || null,
        status: "pending",
        queue_position: counter,
        order_id: null, tx_id: null, channel: null,
        amount: ENTRY_FEE,
        created_at: now(),
        paid_at: null, used_at: null,
        expired_at: null,
        last_bumped_at: null,
        bump_count: 0,
      });
      await saveTickets(env, tickets);

      return json({ success: true, ticket: { number, name, phone, position: counter, status: "pending", entry_fee: ENTRY_FEE } });
    }

    // --- GET TICKET ---
    if (base === "ticket" && param && method === "GET") {
      const ticket = tickets.find(t => t.number === param);
      if (!ticket) return json({ error: "Ticket not found" }, 404);
      const ahead = tickets.filter(t => t.status === "active" && t.queue_position < ticket.queue_position).length;
      const pendingAhead = tickets.filter(t => t.status === "pending" && t.queue_position < ticket.queue_position).length;
      const isExp = isExpired(ticket, tickets);
      const timeLeft = Math.max(0, TIMEOUT_MINUTES - minutesSince(ticket.created_at));
      return json({
        ticket: { ...ticket, ahead_in_queue: ahead, pending_ahead: pendingAhead, is_expired: isExp, minutes_left: Math.round(timeLeft) }
      });
    }

    // --- INITIATE PAYMENT ---
    if (base === "pay" && param && method === "POST") {
      let ticket = tickets.find(t => t.number === param);
      if (!ticket) return json({ error: "Ticket not found" }, 404);
      if (ticket.status === "active") return json({ error: "Already paid" }, 400);
      if (ticket.status === "used") return json({ error: "Already used" }, 400);
      if (ticket.status === "expired") return json({ error: "Ticket expired. Get a new number." }, 400);

      // Check if expired
      if (isExpired(ticket, tickets)) {
        ticket.status = "expired";
        ticket.expired_at = now();
        await saveTickets(env, tickets);
        return json({ error: "Ticket expired. Get a new number.", expired: true }, 400);
      }

      const txId = "EMB_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
      ticket.tx_id = txId;
      await saveTickets(env, tickets);

      try {
        const result = await ppInitiate(
          { name: ticket.name, email: ticket.email, phone: ticket.phone, amount: ticket.amount, txId },
          `https://${host}/api/webhook/palmpesa`
        );
        const ppResult = result.response && result.response.result;
        const ppMessage = result.response && result.response.message;
        if (ppResult === "SUCCESS" && result.order_id) {
          ticket.order_id = result.order_id;
          await saveTickets(env, tickets);
          return json({ success: true, message: "Payment request sent! Check your phone.", order_id: result.order_id });
        }
        return json({ error: ppMessage || result.message || "Payment initiation failed", details: result }, 500);
      } catch (err) {
        return json({ error: "Payment failed: " + err.message }, 500);
      }
    }

    // --- CHECK PAYMENT ---
    if (base === "check-payment" && param && method === "POST") {
      let ticket = tickets.find(t => t.number === param);
      if (!ticket) return json({ error: "Not found" }, 404);

      // Check expiration
      if (ticket.status === "pending" && isExpired(ticket, tickets)) {
        ticket.status = "expired";
        ticket.expired_at = now();
        await saveTickets(env, tickets);
        return json({ status: "expired", message: "Ticket expired. Get a new number." }, 400);
      }

      if (ticket.status === "active") {
        const ahead = tickets.filter(t => t.status === "active" && t.queue_position < ticket.queue_position).length;
        return json({ status: "active", ticket: { ...ticket, ahead_in_queue: ahead } });
      }
      if (ticket.status === "used") return json({ status: "used", ticket });
      if (ticket.status === "expired") return json({ status: "expired", message: "Get a new number." }, 400);

      // Poll PalmPesa for status
      if (ticket.order_id) {
        try {
          const data = await ppCheckOrder(ticket.order_id);
          const pd = data.data && data.data[0] ? data.data[0] : null;
          if (pd && pd.payment_status === "COMPLETED") {
            ticket.status = "active"; ticket.paid_at = now();
            ticket.channel = pd.channel;
            // Reassign queue: this paid ticket moves to front of active queue
            tickets = await reassignQueue(env);
            const ahead = tickets.filter(t => t.status === "active" && t.queue_position < ticket.queue_position).length;
            return json({ status: "active", ticket: { ...ticket, ahead_in_queue: ahead } });
          }
        } catch(e) {}
      }

      // Check if should bump
      if (shouldBump(ticket)) {
        const bumped = await bumpTicket(env, ticket.number);
        if (bumped) {
          return json({ status: "bumped", message: "You were bumped to " + bumped.number + " due to non-payment. Pay promptly to keep your position!", ticket: bumped });
        }
      }

      const timeLeft = Math.max(0, TIMEOUT_MINUTES - minutesSince(ticket.created_at));
      const paidAfter = tickets.filter(t => t.status === "active" && t.queue_position > ticket.queue_position).length;
      return json({ status: "pending", ticket, minutes_left: Math.round(timeLeft), paid_after: paidAfter });
    }

    // --- WEBHOOK ---
    if (path === "/api/webhook/palmpesa" && method === "POST") {
      const orderId = body.order_id || (body.data && body.data[0] && body.data[0].order_id);
      const status = body.payment_status || (body.data && body.data[0] && body.data[0].payment_status);
      if (!orderId) return json({ error: "No order_id" }, 400);

      if (status === "COMPLETED") {
        tickets = await getTickets(env);
        const ticket = tickets.find(t => t.order_id === orderId || t.tx_id === orderId);
        if (ticket && ticket.status === "pending") {
          ticket.status = "active"; ticket.paid_at = now();
          ticket.channel = body.channel || (body.data && body.data[0] && body.data[0].channel);
          await saveTickets(env, tickets);
          // Reassign queue after payment
          await reassignQueue(env);
          return json({ success: true, message: "Ticket activated", number: ticket.number });
        }
      }
      return json({ success: true, message: `Status: ${status}` });
    }

    // --- GUARD SCAN ---
    if (base === "scan" && param && method === "POST") {
      const ticket = tickets.find(t => t.number === param);
      if (!ticket) return json({ error: "Ticket not found", granted: false }, 404);
      if (ticket.status === "used") {
        return json({ granted: false, error: `Already used at ${ticket.used_at}`, ticket: { number: ticket.number, name: ticket.name } }, 403);
      }
      if (ticket.status !== "active") {
        return json({ granted: false, error: "Payment not completed - ticket is RED", ticket: { number: ticket.number, name: ticket.name, status: ticket.status } }, 403);
      }
      ticket.status = "used"; ticket.used_at = now();
      await saveTickets(env, tickets);
      return json({ granted: true, message: "ENTRY GRANTED", ticket: { number: ticket.number, name: ticket.name, used_at: ticket.used_at } });
    }

    // --- ADMIN: MANUAL ACTIVATE ---
    if (base === "admin" && param && parts[2] === "activate" && method === "POST") {
      const ticket = tickets.find(t => t.number === param);
      if (!ticket) return json({ error: "Ticket not found" }, 404);
      if (ticket.status === "active") return json({ error: "Already active" }, 400);
      if (ticket.status === "used") return json({ error: "Already used" }, 400);
      ticket.status = "active"; ticket.paid_at = now(); ticket.channel = "manual";
      await saveTickets(env, tickets);
      await reassignQueue(env);
      return json({ success: true, message: "Ticket manually activated", ticket: { number: ticket.number, name: ticket.name, status: "active" } });
    }

    return json({ error: "Not found" }, 404);
  }
};
