import type { ReviewRecord } from "./store.ts";

// A deliberately tiny, dependency-free dashboard. Lists recent reviews and their
// findings with Accept/Reject buttons that POST a decision. (Next.js is the
// production target; this proves the data path that the learning loop consumes.)
export function renderDashboardHtml(reviews: ReviewRecord[]): string {
  const rows = reviews
    .map((r) => {
      const findings = r.findings
        .map((f) => {
          const badge = f.immutable ? "🔒 policy" : f.source;
          const decided = f.decision ? `<em>${f.decision.state} by ${f.decision.user}</em>` : "";
          return `<li data-fid="${f.id}">
            <b>${esc(f.severity)}</b> · ${esc(badge)} · ${esc(f.path)}:${f.line} — ${esc(f.title)}
            <button onclick="decide('${f.id}','accepted')">Accept</button>
            <button onclick="decide('${f.id}','rejected')">Reject</button>
            <span class="d">${decided}</span>
          </li>`;
        })
        .join("");
      return `<section><h3>${esc(r.org)}/${esc(r.repo)} #${r.pr} — ${esc(r.title)}</h3><ul>${findings}</ul></section>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Cavix</title>
<style>body{font:14px system-ui;margin:2rem;max-width:900px}section{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}button{margin-left:.5rem}.d{margin-left:.5rem;color:#070}</style>
</head><body>
<h1>🔬 Cavix — reviews</h1>
${rows || "<p>No reviews yet.</p>"}
<script>
async function decide(id, state){
  const user = 'demo-user';
  const res = await fetch('/api/findings/'+id+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state,user})});
  if(res.ok){ const li=document.querySelector('[data-fid="'+id+'"] .d'); li.innerHTML='<em>'+state+' by '+user+'</em>'; }
}
</script>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
