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
const BUMP_INTERVAL_SECONDS = BUMP_INTERVAL_MINUTES * 60;
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

function now() { return new Date().toISOString(); }
function minutesSince(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / 60000;
}

// ===== CORE: Reassign ALL numbers sequentially =====
// Paid tickets get E-001, E-002, ... (order of payment)
// Unpaid tickets get E-00N+1, E-00N+2, ... (order of creation)
// All numbers ALWAYS sequential, no gaps
async function reassignAllNumbers(env) {
  let tickets = await getTickets(env);
  let changed = false;

  // 1. Mark expired tickets
  for (const t of tickets) {
    if (t.status === "pending") {
      const timeExpired = minutesSince(t.created_at) >= TIMEOUT_MINUTES;
      const paidAfter = tickets.filter(x => x.status === "active" && x.created_at > t.created_at).length;
      if (timeExpired || paidAfter >= MAX_PAID_GAP) {
        t.status = "expired";
        t.expired_at = now();
        changed = true;
      }
    }
  }

  // 2. Sort: active first (by paid_at), then pending (by created_at)
  const active = tickets.filter(t => t.status === "active").sort((a, b) => new Date(a.paid_at) - new Date(b.paid_at));
  const pending = tickets.filter(t => t.status === "pending").sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const others = tickets.filter(t => t.status !== "active" && t.status !== "pending");

  // 3. Reassign numbers AND queue_position sequentially: E-001, E-002, E-003, ...
  let seq = 1;
  for (const t of active) {
    const newNum = "E-" + pad(seq);
    if (t.number !== newNum || t.queue_position !== seq) {
      if (!t.original_number) t.original_number = t.number;
      t.number = newNum;
      t.queue_position = seq;
      changed = true;
    }
    seq++;
  }
  for (const t of pending) {
    const newNum = "E-" + pad(seq);
    if (t.number !== newNum || t.queue_position !== seq) {
      if (!t.original_number) t.original_number = t.number;
      t.number = newNum;
      t.queue_position = seq;
      changed = true;
    }
    seq++;
  }

  tickets = [...active, ...pending, ...others];
  if (changed) await saveTickets(env, tickets);
  return tickets;
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

    // Reassign numbers on every request
    let tickets = await reassignAllNumbers(env);

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
        currently_serving: used.length,
        entry_fee: ENTRY_FEE,
      });
    }

    // --- CREATE TICKET ---
    if (path === "/api/ticket" && method === "POST") {
      const { name, phone, email } = body;
      if (!name || !phone) return json({ error: "Name and phone required" }, 400);

      // Reassign to get next sequential number
      tickets = await reassignAllNumbers(env);
      const nextNum = tickets.filter(t => t.status === "active" || t.status === "pending").length + 1;
      const number = "E-" + pad(nextNum);

      tickets.push({
        id: Date.now(), number, name,
        phone: phone.replace(/^\+/, ""),
        email: email || null,
        status: "pending",
        amount: ENTRY_FEE,
        created_at: now(),
        last_bumped_at: now(),
        bump_count: 0,
        paid_at: null, used_at: null, expired_at: null,
        order_id: null, tx_id: null, channel: null,
      });
      await saveTickets(env, tickets);

      return json({ success: true, ticket: { number, name, phone, status: "pending", entry_fee: ENTRY_FEE } });
    }

    // --- GET TICKET (by ID or number) ---
    if (base === "ticket" && param) {
      // Search by current number, original number, or ID
      const ticket = tickets.find(t => t.number === param || t.id === param || t.original_number === param);
      if (!ticket) return json({ error: "Ticket not found" }, 404);
      const allActive = tickets.filter(t => t.status === "active");
      const allPending = tickets.filter(t => t.status === "pending");
      // Calculate ahead by queue_position
      const ahead = allActive.filter(t => t.queue_position < ticket.queue_position).length;
      const pendingAhead = allPending.filter(t => t.queue_position < ticket.queue_position).length;
      const timeLeft = ticket.status === "pending" ? Math.max(0, Math.round(TIMEOUT_MINUTES - minutesSince(ticket.created_at))) : 0;
      return json({ ticket: { ...ticket, ahead_in_queue: ahead, pending_ahead: pendingAhead, minutes_left: timeLeft, total_active: allActive.length, total_pending: allPending.length } });
    }

    // --- INITIATE PAYMENT ---
    if (base === "pay" && param && method === "POST") {
      const ticket = tickets.find(t => t.number === param);
      if (!ticket) return json({ error: "Ticket not found" }, 404);
      if (ticket.status === "active") return json({ error: "Already paid" }, 400);
      if (ticket.status === "used") return json({ error: "Already used" }, 400);
      if (ticket.status === "expired") return json({ error: "Ticket expired. Get a new number." }, 400);

      // Check expiration
      const timeExpired = minutesSince(ticket.created_at) >= TIMEOUT_MINUTES;
      const paidAfter = tickets.filter(x => x.status === "active" && x.created_at > ticket.created_at).length;
      if (timeExpired || paidAfter >= MAX_PAID_GAP) {
        ticket.status = "expired"; ticket.expired_at = now();
        await saveTickets(env, tickets);
        await reassignAllNumbers(env);
        return json({ error: "Ticket expired. Your number was given to someone else.", expired: true }, 400);
      }

      const txId = "EMB_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
      ticket.tx_id = txId;
      await saveTickets(env, tickets);

      try {
        const result = await ppInitiate(
          { name: ticket.name, email: ticket.email, phone: ticket.phone, amount: ticket.amount, txId },
          `https://${host}/api/webhook/palmpesa`
        );
        // Log full response for debugging
        console.log("[PalmPesa]", JSON.stringify(result));
        const ppResult = result && result.response && result.response.result;
        const ppMessage = result && result.response && result.response.message;
        const ppResultCode = result && result.response && result.response.resultcode;
        if (ppResult === "SUCCESS" && result.order_id) {
          ticket.order_id = result.order_id;
          await saveTickets(env, tickets);
          return json({ success: true, message: "Payment request sent! Check your phone.", order_id: result.order_id });
        }
        // Return full PalmPesa response for debugging
        return json({ 
          error: ppMessage || (result && result.message) || "Payment initiation failed", 
          result_code: ppResultCode,
          result_status: ppResult,
          full_response: result 
        }, 500);
      } catch (err) {
        console.error("[PalmPesa Error]", err.message);
        return json({ error: "Payment failed: " + err.message, stack: err.stack }, 500);
      }
    }

    // --- CHECK PAYMENT ---
    if (base === "check-payment" && param && method === "POST") {
      const ticket = tickets.find(t => t.number === param);
      if (!ticket) {
        // Number may have changed - search by tx_id or order_id in body
        return json({ error: "Not found - number may have changed" }, 404);
      }

      if (ticket.status === "expired") return json({ status: "expired", message: "Ticket expired. Get a new number." }, 400);
      if (ticket.status === "active") {
        const ahead = tickets.filter(t => t.status === "active" && t.queue_position < ticket.queue_position).length;
        return json({ status: "active", ticket: { ...ticket, ahead_in_queue: ahead, total_active: tickets.filter(t => t.status === "active").length } });
      }
      if (ticket.status === "used") return json({ status: "used", ticket });

      // Check expiration
      const timeExpired = minutesSince(ticket.created_at) >= TIMEOUT_MINUTES;
      const paidAfter = tickets.filter(x => x.status === "active" && x.created_at > ticket.created_at).length;
      if (timeExpired || paidAfter >= MAX_PAID_GAP) {
        ticket.status = "expired"; ticket.expired_at = now();
        await saveTickets(env, tickets);
        await reassignAllNumbers(env);
        return json({ status: "expired", message: "Ticket expired. Your number was reassigned." }, 400);
      }

      // Poll PalmPesa
      if (ticket.order_id) {
        try {
          const data = await ppCheckOrder(ticket.order_id);
          const pd = data.data && data.data[0] ? data.data[0] : null;
          if (pd && pd.payment_status === "COMPLETED") {
            ticket.status = "active"; ticket.paid_at = now();
            ticket.channel = pd.channel;
            await saveTickets(env, tickets);
            // Reassign numbers: paid ticket moves to lowest available
            tickets = await reassignAllNumbers(env);
            // Find updated ticket in new array (old reference is stale)
            const updatedTicket = tickets.find(t => t.id === ticket.id) || ticket;
            const ahead = tickets.filter(t => t.status === "active" && t.number < updatedTicket.number).length;
            return json({ status: "active", ticket: { ...updatedTicket, ahead_in_queue: ahead } });
          }
        } catch(e) {}
      }

      // Calculate bump countdown
      const lastBumpTime = ticket.last_bumped_at || ticket.created_at;
      const secondsSinceBump = (Date.now() - new Date(lastBumpTime).getTime()) / 1000;
      const bumpInSeconds = Math.max(0, Math.round(BUMP_INTERVAL_SECONDS - secondsSinceBump));
      const timeLeft = Math.max(0, Math.round(TIMEOUT_MINUTES - minutesSince(ticket.created_at)));

      // Check if should bump now (interval reached)
      if (secondsSinceBump >= BUMP_INTERVAL_SECONDS) {
        ticket.bump_count = (ticket.bump_count || 0) + 1;
        ticket.last_bumped_at = now();
        await saveTickets(env, tickets);
        // Reassign all numbers - this ticket will get pushed to end
        tickets = await reassignAllNumbers(env);
        // Find ticket with updated number
        const bumpedTicket = tickets.find(t => t.id === ticket.id);
        if (bumpedTicket) {
          return json({ 
            status: "bumped", 
            message: "Your number changed due to non-payment!", 
            old_number: param,
            ticket: bumpedTicket,
            bump_count: bumpedTicket.bump_count,
            bump_in_seconds: BUMP_INTERVAL_SECONDS
          });
        }
      }

      return json({ 
        status: "pending", 
        ticket, 
        minutes_left: timeLeft,
        bump_in_seconds: bumpInSeconds,
        bump_count: ticket.bump_count || 0
      });
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
          // Reassign all numbers after payment
          tickets = await reassignAllNumbers(env);
          const updatedTicket = tickets.find(t => t.id === ticket.id) || ticket;
          return json({ success: true, message: "Ticket activated", number: updatedTicket.number });
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
      await reassignAllNumbers(env);
      return json({ success: true, message: "Ticket manually activated", ticket: { number: ticket.number, name: ticket.name, status: "active" } });
    }

    // --- DEBUG: DUMP ALL TICKETS ---
    if (path === "/api/admin/tickets" && method === "GET") {
      const simplified = tickets.map(t => ({
        number: t.number,
        original: t.original_number || t.number,
        name: t.name,
        status: t.status,
        queue_pos: t.queue_position,
        paid_at: t.paid_at,
        created: t.created_at,
        bump_count: t.bump_count || 0,
      }));
      return json({ total: tickets.length, tickets: simplified });
    }

    // --- TEST: DIRECT PALMPESA CALL ---
    if (path === "/api/test-pay" && method === "POST") {
      try {
        const testPhone = body.phone || "255754123456";
        const testAmount = body.amount || 200;
        const result = await ppInitiate(
          { name: "Test User", email: "test@test.com", phone: testPhone, amount: testAmount, txId: "TEST_" + Date.now() },
          `https://${host}/api/webhook/palmpesa`
        );
        return json({ test: true, palmpesa_response: result, phone_used: testPhone, amount: testAmount });
      } catch (err) {
        return json({ test: true, error: err.message, stack: err.stack }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  }
};
