"use strict";
/* Maintenance console (staff) and the ticket detail shared with the admin's All tickets view. */

function ticketTable(ts, { me, district }) {
  return `<div class="tablewrap"><table><thead><tr><th>Ticket</th><th>Property</th>${district ? "<th>District</th>" : ""}<th>Issue</th><th>Severity</th><th>Status</th><th>SLA</th><th class="r">Seen</th><th>Assigned</th></tr></thead><tbody>
   ${ts.map(t => `<tr class="click" data-act="sel" data-k="tk" data-v="${t.ticket_id}" tabindex="0" style="${t.ticket_id === APP.sel.tk ? "outline:2px solid var(--accent);outline-offset:-2px" : ""}"><td class="mono">${t.ticket_no}</td><td class="mono">${t.property_code}</td>${district ? `<td>${esc(t.district_name)}</td>` : ""}<td>${issue(t.issue_type)}</td><td>${sev(t.severity)}</td><td>${badge(t.status)}</td><td>${slaBadge(t)}</td><td class="r">${t.occurrence_count}×</td><td>${t.assigned_name ? esc(t.assigned_name) + (t.assigned_to === me ? " (you)" : "") : "–"}</td></tr>`).join("")}</tbody></table></div>`;
}

async function ticketDetail(id, canAct) {
  const { ticket: t, history, entries } = await api(`/tickets/${id}`);
  const u = APP.user, nexts = TRANSITIONS[t.status];
  const mine = !t.assigned_to || t.assigned_to === u.user_id;
  return `<div class="panel"><div class="panel-head"><div><span class="eyebrow">${esc(t.property_code)} · ${esc(t.address_line)} · ${esc(t.zone_name)}</span><h2 class="mono">${t.ticket_no}</h2></div><div class="row">${sev(t.severity)}${badge(t.status)}</div></div>
   <p style="margin-bottom:8px">${esc(t.description)}</p>
   <p class="muted" style="margin-bottom:10px">Source ${t.source.toLowerCase()}${t.meter_code ? ` · meter <span class="mono">${t.meter_code}</span>` : ""} · opened ${fmtDT(t.reported_timestamp)} · seen ${t.occurrence_count}× · last ${fmtT(t.last_seen_at)}${t.assigned_name ? ` · assigned to ${esc(t.assigned_name)}` : ""}</p>
   <p style="margin-bottom:10px">SLA ${SLA_H[t.severity]} h for ${t.severity.toLowerCase()} · due ${fmtDT(t.sla_due_at)} ${slaBadge(t)}${t.escalated_at ? ` <span class="status s-crit">escalated ${fmtT(t.escalated_at)}</span>` : ""}</p>
   ${t.resolution_notes ? `<p style="margin-bottom:10px"><b>Resolution:</b> ${esc(t.resolution_notes)}</p>` : ""}
   ${canAct ? (mine ? `<div class="stack" style="border-top:1px solid var(--line);padding-top:12px"><div class="row"><h3>Update status</h3>${src("pg")}</div>
     <div class="row">${t.status === "OPEN" ? `<button class="btn primary" data-act="t-take" data-id="${t.ticket_id}">Take this ticket</button>` : ""}
     ${t.status !== "OPEN" ? nexts.map(s => `<button class="btn ${s === "RESOLVED" ? "primary" : ""}" data-act="t-move" data-to="${s}" data-id="${t.ticket_id}">Move to ${s.replace("_", " ").toLowerCase()}</button>`).join("") : ""}
     ${t.status !== "CLOSED" && !nexts.includes("CLOSED") ? `<button class="btn danger" data-act="t-move" data-to="CLOSED" data-id="${t.ticket_id}" title="Shows the trigger rejecting an illegal transition">Try to close directly</button>` : ""}</div>
     ${nexts.includes("RESOLVED") ? `<label class="f">Resolution notes (required to resolve)<input class="in" id="t-res" value="${t.issue_type === "LEAK" ? "Replaced burst joint on main inlet; flow back to normal." : "Fault found and fixed on site; readings back to normal."}"></label>` : ""}
     <div id="t-err"></div></div>` : `<p class="muted" style="border-top:1px solid var(--line);padding-top:12px">Assigned to ${esc(t.assigned_name)}. Only they can move it on.</p>`) : ""}
   <div class="grid2" style="margin-top:12px"><div><div class="row" style="margin-bottom:6px"><h3>Status history</h3>${src("pg")}</div>
     <div class="tablewrap"><table><tbody>${history.map(h => `<tr><td>${fmtDT(h.changed_at)}</td><td>${h.from_status ? esc(h.from_status) + " → " : ""}<b>${esc(h.to_status)}</b></td><td class="muted">${esc(h.changed_by_name)}</td></tr>`).join("")}</tbody></table></div>
     <p class="muted" style="font-size:12px;margin-top:4px">Written by trigger trg_ticket_history.</p></div>
    <div><div class="row" style="margin-bottom:6px"><h3>Field notes</h3>${src("mg")}</div>
     <div class="stack">${entries.map(e => `<div style="border-left:2px solid var(--line);padding-left:8px"><div class="muted" style="font-size:12px">${fmtDT(e.at)} · ${esc(e.by)} · ${esc(e.kind)}</div><div>${esc(e.text)}</div>${e.data ? `<pre class="json">${esc(JSON.stringify(e.data))}</pre>` : ""}${canAct && e.kind === "NOTE" && e.by === u.display_name ? `<button class="btn small danger" data-act="note-del" data-id="${t.ticket_id}" data-entry="${e.id}">Delete note</button>` : ""}</div>`).join("") || `<p class="muted">No notes yet.</p>`}
     ${canAct ? `<form class="stack" id="note-form" data-id="${t.ticket_id}"><textarea class="in" name="text">Crew on site. Main valve isolated; supply paused for the repair.</textarea><div><button class="btn" type="submit">Add note</button></div></form>` : ""}</div></div></div></div>`;
}

V.queue = async () => {
  const { tickets } = await api("/tickets");
  const sel = tickets.find(t => t.ticket_id === APP.sel.tk) || tickets[0];
  if (sel) APP.sel.tk = sel.ticket_id;
  return `<div class="page-head"><span class="eyebrow">Maintenance console · ${esc(APP.user.zone_name || "")}</span><h1>Ticket queue</h1>
   <p class="ink2">Row-level security shows staff only tickets for properties in their district. Kavya (South District) sees a different list from Ravi and Neha.</p></div>
  <div class="panel"><div class="panel-head"><h2>Tickets in ${esc(APP.user.zone_name || "your district")}</h2>${src("pg")}</div>
   ${tickets.length ? ticketTable(tickets, { me: APP.user.user_id }) : `<p class="muted">No tickets in your district yet. Ask the admin to run the pipe-burst scenario at Asha's home (Ward N-1), or a resident to submit a complaint.</p>`}</div>
  ${sel ? await ticketDetail(sel.ticket_id, true) : ""}`;
};

ACT["t-take"] = async b => {
  try { await post(`/tickets/${b.dataset.id}/take`); toast("Ticket taken."); await render(); }
  catch (e) { $("#t-err").innerHTML = errBox(e); refreshRail(); }
};
ACT["t-move"] = async b => {
  const to = b.dataset.to, notes = $("#t-res") ? $("#t-res").value : null;
  try {
    await post(`/tickets/${b.dataset.id}/status`, { to, notes });
    toast(to === "RESOLVED" ? "Resolved. The meter is back to normal readings." : `Moved to ${to.replace("_", " ").toLowerCase()}.`);
    await render();
  } catch (e) { $("#t-err").innerHTML = errBox(e); refreshRail(); }
};
ACT["note-del"] = async b => { await del(`/tickets/${b.dataset.id}/notes/${b.dataset.entry}`); await render(); };
FORMS["note-form"] = async f => {
  const text = new FormData(f).get("text").trim(); if (!text) return;
  await post(`/tickets/${f.dataset.id}/notes`, { text }); await render();
};
