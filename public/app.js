const $ = selector => document.querySelector(selector);
const token = $('meta[name="tongyun-session"]').content;
const state = { tables: [], table: 'customers', rows: [], columns: [], selected: null, plan: null, cursor: null, browse: true,
  connection:{id:'local-sqlite',engine:'sqlite',allowWrites:true}, connections:[], redisKey:null };
const display = value => value === null ? 'NULL' : value && typeof value === 'object' && '$integer' in value ? value.$integer : typeof value === 'object' ? JSON.stringify(value) : String(value);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const errors = { ROW_CONFLICT: '数据已发生变化，请重新查询并生成计划。', APPROVAL_REQUIRED: '确认信息与当前计划不一致，请重新审查。', QUERY_REJECTED: '查询被拒绝。仅支持普通数据表的单条只读 SELECT，部分函数暂不支持。', QUERY_TIMEOUT: '查询超过 2 秒已停止，请缩小范围或优化索引。', NO_CHANGE: '新旧值相同，无需变更。', DATABASE_ERROR: '数据库拒绝此操作，请检查字段类型与约束。', CONTEXT_MISMATCH: '此计划不属于当前任务或环境。', INVALID_CHANGE: '请使用实际存在的非主键字段，以及字符串、数值或 NULL。' };
async function api(path, body) {
  const connectionId=state.connection.id;
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Tongyun-Actor': 'human:local', 'X-Tongyun-Task': $('#task').value.trim() || 'local-demo', 'X-Tongyun-Connection':connectionId }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if(state.connection.id!==connectionId) throw new Error('连接已切换，请在当前连接重新查询。');
  if (!data.ok) throw new Error(errors[data.error] ?? `操作未完成：${data.error}`);
  return data;
}
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3500); }
async function action(button, errorBox, fn) {
  if (button.disabled) return;
  button.disabled = true; errorBox.hidden = true; $('#status').textContent = '操作进行中…';
  try { await fn(); $('#status').textContent = '操作完成 · 已记录'; }
  catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; $('#status').textContent = '操作失败 · 请查看说明'; toast(error.message); }
  finally { button.disabled = button === $('#next-page') ? !state.cursor : button === $('#prepare') ? !state.selected || !state.connection.allowWrites : false; }
}
function clearSelection() { state.selected = null; state.plan = null; state.redisKey=null; $('#selection').textContent = '尚未选择数据行或 Key'; $('#prepare').disabled = true; $('#plan-detail').hidden = true; $('#change-form').hidden = false; $('#redis-key-view').hidden=true; $('.intro').textContent = state.connection.allowWrites ? '选择记录或 Key，生成变更与恢复计划后再确认执行。' : '当前连接仅允许读取。需要变更时请使用已显式开启受控变更的非生产连接。'; }
async function selectRow(row) {
  state.selected = row; state.plan = null; $('#plan-detail').hidden = true;
  $('#change-form').hidden = false; $('.intro').textContent = '填写修改字段。系统读取真实旧值，并生成配套回滚 SQL。';
  if(state.connection.engine==='redis') {
    $('.intro').textContent = '选择 Redis 操作，准备变更与恢复快照。';
    $('#prepare').disabled=true;
    const data=await api('redis/read',{key:row.key});
    if(state.selected!==row) return;
    state.redisKey=data;
    $('#selection').textContent=`${row.key} / ${data.type}`;
    $('#redis-key-view').hidden=false;
    $('#redis-key-name').textContent=row.key;
    $('#redis-key-meta').textContent=`${data.type} · ${data.memory} B · ${data.ttlMs===-1?'永久':`TTL ${Math.ceil(data.ttlMs/1000)} 秒`}`;
    $('#redis-value').textContent=JSON.stringify(data.value,null,2);
    redisActions(data);
    $('#prepare').disabled=!state.connection.allowWrites;
    renderRows(); return;
  }
  const schema = state.tables.find(t => t.name === state.table);
  const key = schema?.columns.find(c => c.pk === 1)?.name;
  $('#selection').textContent = `${state.table}  /  ${key} = ${display(row[key])}`;
  $('#prepare').disabled = !key || !state.connection.allowWrites;
  renderRows();
}
const rowHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--db-row-height'));
function renderRows() {
  const container = $('#result');
  if (!state.rows.length) { container.replaceChildren(el('div', '没有符合条件的数据', 'empty')); return; }
  let table = container.querySelector('table');
  if (!table) {
    table = el('table'); const head = el('thead'); const tr = el('tr');
    tr.append(el('th', '#', 'row-number'));
    state.columns.forEach(c => tr.append(el('th', state.connection.engine==='redis'?({key:'Key',type:'类型',ttlMs:'TTL / 秒',memoryBytes:'内存 / B'}[c]??c):c)));
    head.append(tr); table.append(head, el('tbody')); container.replaceChildren(table);
  }
  const body = table.querySelector('tbody');
  const start = Math.max(0, Math.floor(container.scrollTop / rowHeight) - 5);
  const end = Math.min(state.rows.length, start + Math.ceil(container.clientHeight / rowHeight) + 12);
  const fragment = document.createDocumentFragment();
  function spacer(height) { if (!height) return; const tr = el('tr'); tr.className = 'spacer'; const td = el('td'); td.colSpan = state.columns.length + 1; td.style.height = `${height}px`; tr.append(td); fragment.append(tr); }
  spacer(start * rowHeight);
  state.rows.slice(start, end).forEach((row, offset) => {
    const tr = el('tr'); tr.className = state.selected === row ? 'selected-row' : '';
    tr.append(el('td', String(start + offset + 1), 'row-number'));
    state.columns.forEach(c => { const value=state.connection.engine==='redis'&&c==='ttlMs'?(row[c]===-1?'永久':row[c]===-2?'已过期':Math.ceil(row[c]/1000)):display(row[c]); const td = el('td', value); if (row[c] === null) td.className = 'null-value'; td.title = String(value); tr.append(td); });
    if (state.browse) { tr.tabIndex = 0; tr.setAttribute('aria-label', `选择第 ${start + offset + 1} 行`); tr.onclick = () => selectRow(row).catch(e=>toast(e.message)); tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRow(row).catch(e=>toast(e.message)); } }; }
    fragment.append(tr);
  });
  spacer((state.rows.length - end) * rowHeight);
  body.replaceChildren(fragment);
}
$('#result').addEventListener('scroll', () => requestAnimationFrame(renderRows));
new ResizeObserver(() => renderRows()).observe($('#result'));
function showResult(data, elapsed) {
  state.rows = data.rows; state.columns = data.columns; state.cursor = data.nextCursor ?? null;
  $('#row-count').textContent = `${data.rows.length} ${state.connection.engine==='redis'?'个 Key':'行'}`;
  $('#query-time').textContent = `${Math.round(elapsed)} ms · ${state.connection.engine==='redis'?'SCAN 分批扫描':state.browse ? '主键游标分页' : '只读 SQL'}`;
  $('#result-note').textContent = state.connection.engine==='redis' ? 'SCAN 弱一致性遍历 · 单页最多 1000 个 Key' : data.truncated ? '结果已截断 · 最多 1000 行 / 2 MiB' : '当前页加载完成 · 无全表计数';
  $('#next-page').disabled = !state.cursor;
  clearSelection(); $('#result').replaceChildren(); $('#result').scrollTop = 0; renderRows();
}
async function browse(after) {
  const connectionId=state.connection.id;const table=state.table;
  const start=performance.now(); let data;
  if(state.connection.engine==='redis') data=await api('redis/scan',{cursor:after??'0',pattern:$('#key-pattern').value||'*'});
  else { await ensureTable(); if(state.table!==table||state.connection.id!==connectionId)return;data=await api('browse',{table,...(after===undefined?{}:{after})}); }
  if(state.connection.id!==connectionId||state.table!==table)return;
  state.browse=true; showResult(data,performance.now()-start);
}
async function ensureTable() {
  const table=state.tables.find(t=>t.name===state.table);
  if(table && !table.columns.length && state.connection.engine==='mysql') {
    const info=(await api(`schema?table=${encodeURIComponent(state.table)}`)).tables[0];
    state.tables[state.tables.indexOf(table)]=info; renderStructure();
  }
}
async function schema() {
  if(state.connection.engine==='redis') { state.tables=[]; $('#tables').replaceChildren(el('div','SCAN · 按模式浏览 Key','connection-detail')); $('#structure').replaceChildren(el('div','Redis 类型、TTL 和内存信息显示在 Key 详情中。','empty')); return; }
  state.tables = (await api('schema')).tables;
  if(!state.tables.some(t=>t.name===state.table)) state.table=state.tables[0]?.name??'';
  $('#tables').replaceChildren(...state.tables.map(table => {
    const button = el('button', `▦　${table.name}`, table.name === state.table ? 'table-button selected' : 'table-button');
    button.onclick = () => action(button, $('#query-error'), async () => {
      state.table = table.name; $('#breadcrumb').textContent = table.name;
      await ensureTable(); if(state.table!==table.name)return;setDefaultSql();
      await browse();if(state.table!==table.name)return;renderStructure(); $('#tables').querySelectorAll('button').forEach(b => b.classList.toggle('selected', b === button));
    }); return button;
  })); renderStructure();
}
function renderStructure() {
  const info = state.tables.find(t => t.name === state.table); if (!info) return;
  const table = el('table'); const head = el('tr'); ['字段', '类型', '约束'].forEach(t => head.append(el('th', t))); table.append(head);
  info.columns.forEach(c => { const tr = el('tr'); tr.append(el('td', c.name), el('td', c.type), el('td', [c.pk ? 'PRIMARY KEY' : '', c.notnull ? 'NOT NULL' : ''].filter(Boolean).join(' · '))); table.append(tr); });
  $('#structure').replaceChildren(table, el('pre', info.sql));
}
const stateLabel = { prepared: '待确认', applied: '已执行 · 可回滚', rolled_back: '已回滚',applying:'执行中 / 待核查',rolling_back:'回滚中 / 待核查',unknown:'结果未知 · 禁止重试' };
async function openPlan(id) {
  const plan = await api(`plans/${id}`); state.plan = plan;
  $('#selection').textContent = plan.engine==='redis' ? `计划 Key ${plan.key}` : `计划目标 ${plan.table} / ${plan.key} = ${display(plan.keyValue)}`;
  $('#change-form').hidden = true; $('.intro').textContent = `正在审查由 ${plan.context.actor} 创建的计划。执行前请核对差异与回滚材料。`;
  $('#plan-detail').hidden = false; $('#plan-state').textContent = stateLabel[plan.state]; $('#plan-short').textContent = plan.id.slice(0, 8);
  const fields = [...new Set([...Object.keys(plan.before),...Object.keys(plan.after)])].filter(k => display(plan.before[k]) !== display(plan.after[k]));
  $('#field-diff').replaceChildren(...fields.map(k => { const row = el('div', undefined, 'field-change'); row.append(el('span', k), el('del', display(plan.before[k])), el('ins', display(plan.after[k]))); return row; }));
  $('#forward-sql').textContent = `${plan.forward.sql}${plan.forward.parameters.length?`\n\n参数: ${plan.forward.parameters.map(display).join(', ')}`:''}`;
  $('#rollback-sql').textContent = `${plan.rollback.sql}${plan.rollback.parameters.length?`\n\n参数: ${plan.rollback.parameters.map(display).join(', ')}`:''}`;
  $('#apply').hidden = plan.state !== 'prepared' || !state.connection.allowWrites; $('#rollback').hidden = plan.state !== 'applied' || !state.connection.allowWrites;
  if(['unknown','applying','rolling_back'].includes(plan.state)) $('.private-note').textContent='远程执行结果需核查。请读取当前数据并对照快照，禁止直接重试这份计划。';
  else $('.private-note').textContent=plan.engine==='redis'?'二进制恢复快照已保存在本机；回滚保留原绝对过期时间，不复活已过期的原值。':'参数与前后快照保存在本机；回滚前核对新值，避免覆盖后续修改。';
}
async function plans() {
  const data = await api('plans');
  $('#plans').replaceChildren(...(data.plans.length ? data.plans.map(p => { const button = el('button', undefined, 'plan-item'); button.append(el('span', `${p.table} · ${stateLabel[p.state]}`), el('code', `${p.actor} / ${p.id.slice(0, 8)}`)); button.onclick = () => action(button, $('#change-error'), () => openPlan(p.id)); return button; }) : [el('div', '暂无变更计划。AI 与人在当前任务中创建的计划会显示在这里。', 'empty compact')]));
}
const actions = { discover: '发现能力', read_schema: '读取表结构', prepare_browse: '准备分页', query: '执行查询', prepare_update: '准备更新', inspect_plan: '审查计划', apply: '执行变更', rollback: '执行回滚', approve_apply: '确认执行', approve_rollback: '确认回滚', cancel_confirmation: '取消确认', inspect_query: '查看原始查询', list_plans: '读取计划', read_audit: '读取记录' };
Object.assign(actions,{redis_scan:'扫描 Key',redis_read:'读取 Key',browse:'读取数据页',test_connection:'测试连接',list_connections:'读取连接',add_connection:'保存连接',remote_result:'记录远程结果',inspect_operation:'查看操作参数'});
let auditCursor = null;
let viewingOlderAudit = false;
async function audit(before) {
  const data = await api(before ? `audit?before=${encodeURIComponent(before)}` : 'audit');
  viewingOlderAudit = Boolean(before); auditCursor = data.nextBefore; $('#older-audit').disabled = !auditCursor;
  const events = data.events.filter(e => e.taskId === ($('#task').value.trim() || 'local-demo') && e.connectionId===state.connection.id && !['read_audit', 'list_plans'].includes(e.action)).reverse();
  $('#event-count').textContent = events.length;
  $('#timeline').replaceChildren(...events.map(event => { const row = el('div', undefined, `event ${event.outcome}`); const copy = el('div'); const outcome = {started:'开始',succeeded:'完成',failed:'失败',recorded:'已确认'}[event.outcome] ?? event.outcome; copy.append(el('div', `${actions[event.action] ?? event.action} · ${outcome}`), el('small', `${event.actor} · ${event.taskId}${event.code ? ` · ${event.code}` : ''}${event.planId ? ` · ${event.planId.slice(0, 8)}` : ''}`)); row.append(el('span', event.outcome === 'succeeded' ? '✓' : event.outcome === 'failed' ? '!' : '·', 'event-mark'), copy, el('span', new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false }), 'event-time'));
    if (event.action === 'query' && event.outcome === 'succeeded') { const button = el('button', '查看 SQL'); button.onclick = () => action(button, $('#query-error'), async () => { const record = await api(`queries/${event.operationId}`); $('#query-dialog h2').textContent='私有查询记录'; $('#query-record').textContent = record.sql; $('#query-dialog').showModal(); }); row.append(button); }
    if(state.connection.engine!=='sqlite'&&event.outcome==='succeeded'&&['read_schema','browse','redis_scan','redis_read','prepare_update'].includes(event.action)) {const button=el('button','查看参数');button.onclick=()=>action(button,$('#query-error'),async()=>{const record=await api(`operations/${event.operationId}`);$('#query-dialog h2').textContent='私有操作参数';$('#query-record').textContent=JSON.stringify(record.request,null,2);$('#query-dialog').showModal();});row.append(button);}
    return row; }));
}
$('#run').onclick = () => action($('#run'), $('#query-error'), async () => { const start = performance.now(); const data = await api('query', { sql: $('#sql').value }); state.browse = false; showResult(data, performance.now() - start); await audit(); });
$('#sql').onkeydown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('#run').click(); } };
$('#first-page').onclick = () => action($('#first-page'), $('#query-error'), () => browse());
$('#next-page').onclick = () => action($('#next-page'), $('#query-error'), () => browse(state.cursor));
$('#change-form').onsubmit = e => { e.preventDefault(); action($('#prepare'), $('#change-error'), async () => {
  const key = state.tables.find(t => t.name === state.table)?.columns.find(c => c.pk === 1)?.name;
  if (!state.selected || (state.connection.engine!=='redis'&&!key)) throw new Error('请先选择数据记录或 Key。');
  let changes; try { changes = JSON.parse($('#changes').value); } catch { throw new Error('修改字段需要有效的 JSON 对象。'); }
  const value = state.selected[key];
  const plan = await api('plans', state.connection.engine==='redis' ? {key:state.selected.key,changes} : { table: state.table, key: value?.$integer ?? value, changes });
  await openPlan(plan.id); await plans(); await audit(); toast(state.connection.engine==='redis'?'变更与恢复命令已准备，尚未执行。':'变更计划与回滚 SQL 已准备，尚未执行。');
}); };
async function confirmChange(rollback) {
  const plan = state.plan; if (!plan) return;
  $('#confirm-title').textContent = rollback ? '回滚这一条变更？' : '执行这一条更新？';
  $('#confirm-description').textContent = `${state.connection.name} / ${plan.table} · 影响 1 ${plan.engine==='redis'?'个 Key':'行'} · ${rollback ? '当前数据必须与变更后的记录一致，否则拒绝回滚。' : '当前数据必须与预览旧值一致，否则拒绝执行。'}`;
  $('#confirm-digest').textContent = `计划指纹 ${plan.digest.slice(0, 20)}…`;
  $('#confirm-submit').textContent = rollback ? '确认回滚' : '确认执行';
  const dialog = $('#confirm'); dialog.returnValue = ''; dialog.showModal();
  const result = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (result !== 'confirm') { await api(`plans/${plan.id}/cancel-confirmation`, {}); await audit(); return; }
  await api(`plans/${plan.id}/${rollback ? 'rollback' : 'apply'}`, { approvedDigest: plan.digest });
  if (state.browse) await browse();
  await openPlan(plan.id); await plans(); await audit(); toast(rollback ? '已恢复变更前数据，回滚已记录。' : '更新已完成，回滚计划与执行记录已保存。');
}
$('#apply').onclick = () => action($('#apply'), $('#change-error'), () => confirmChange(false));
$('#rollback').onclick = () => action($('#rollback'), $('#change-error'), () => confirmChange(true));
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-selected', b === button)); ['query', 'structure', 'audit'].forEach(view => $(`#${view}-view`).hidden = view !== button.dataset.view); if (button.dataset.view === 'audit') audit().catch(e => toast(e.message)); });
$('#theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('tongyun-theme', theme); };
document.documentElement.dataset.theme = localStorage.getItem('tongyun-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('#task').onchange = () => { clearSelection(); Promise.all([plans(), audit()]).catch(e => toast(e.message)); };
$('#refresh-schema').onclick = () => action($('#refresh-schema'), $('#query-error'), schema);
$('#refresh-plans').onclick = () => plans().catch(e => toast(e.message));
$('#refresh-audit').onclick = () => audit().catch(e => toast(e.message));
$('#older-audit').onclick = () => audit(auditCursor).catch(e => toast(e.message));
$('#agent-open').onclick = () => { $('#agent-doc').textContent = `${location.origin}\n\nGET  /api/connections\nPOST /api/connections/:id/test\nGET  /api/capabilities\nGET  /api/schema\nPOST /api/query       { sql }\nPOST /api/browse      { table, after? }\nPOST /api/redis/scan  { pattern, cursor? }\nPOST /api/redis/read  { key }\nPOST /api/plans       { table, key, changes }\nGET  /api/plans/:id\nPOST /api/plans/:id/apply\nPOST /api/plans/:id/rollback\nGET  /api/audit\n\nAuthorization: Bearer <本机令牌>\nX-Tongyun-Connection: ${state.connection.id}\nX-Tongyun-Actor: agent:your-agent\nX-Tongyun-Task: local-demo\n\n执行 / 回滚请求：{ approvedDigest }`; $('#agent-dialog').showModal(); };
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }));
function setDefaultSql() {
  const table=state.tables.find(t=>t.name===state.table); if(!table) return;
  const quote=state.connection.engine==='mysql'?name=>`\`${name.replaceAll('`','``')}\``:name=>`"${name.replaceAll('"','""')}"`;
  const key=table.columns.find(c=>c.pk)?.name;
  $('#sql').value=`SELECT *\nFROM ${quote(table.name)}${key?`\nORDER BY ${quote(key)}`:''}\nLIMIT 1000;`;
}
function redisActions(data) {
  $('#redis-action').disabled=false;
  const types={string:['set'],hash:['hash_set'],list:['list_set'],set:['set_add','set_remove'],zset:['zset_add']};
  const labels={set:'修改 String',hash_set:'设置 Hash 字段',list_set:'修改 List 元素',set_add:'添加 Set 成员',set_remove:'移除 Set 成员',zset_add:'设置 ZSet 成员',ttl:'设置 TTL',delete:'删除 Key（保留恢复快照）'};
  $('#redis-action').replaceChildren(...[...(types[data.type]??[]),'ttl','delete'].map(action=>{const option=el('option',labels[action]);option.value=action;return option;}));
  $('#redis-action').onchange=()=>{
    const action=$('#redis-action').value;
    const templates={set:{action,value:data.value},hash_set:{action,fields:data.value},list_set:{action,index:0,value:data.value?.[0]??''},set_add:{action,members:['new-member']},set_remove:{action,members:[data.value?.[0]??'member']},zset_add:{action,members:[{score:1,value:'new-member'}]},ttl:{action,seconds:60},delete:{action}};
    $('#changes').value=JSON.stringify(templates[action],null,2);
  };
  $('#redis-action').onchange();
}
async function loadConnections() {
  state.connections=(await api('connections')).connections;
  $('#connection-select').replaceChildren(...state.connections.map(c=>{const option=el('option',`${c.engine.toUpperCase()} · ${c.name}`);option.value=c.id;return option;}));
}
async function selectConnection(id) {
  const connection=state.connections.find(c=>c.id===id); if(!connection) return;
  state.connection=connection; state.table='';state.tables=[];state.rows=[];state.columns=[];state.cursor=null;
  $('#connection-select').value=id;localStorage.setItem('tongyun-connection',id);
  clearSelection();$('#result').replaceChildren(el('div','正在读取连接…','empty'));$('#tables').replaceChildren();$('#structure').replaceChildren();$('#plans').replaceChildren();$('#row-count').textContent='—';$('#query-error').hidden=true;$('#change-error').hidden=true;
  const redis=connection.engine==='redis';
  $('#connection-name').textContent=connection.name;
  $('#connection-meta').textContent=connection.host?`${connection.host}:${connection.port} / ${connection.database}`:'合成数据 · 本机存储';
  $('#engine-label').textContent=connection.engine.toUpperCase();$('#environment-label').textContent=connection.environment;
  $('#connection-policy').textContent=connection.allowWrites?'受控变更已开启 · 必须预览与确认':'只读连接 · 变更已禁用';
  $('#atomic-note').textContent=connection.engine==='sqlite'?'✓　执行与审计原子提交':'✓　先持久化意图 · 断线结果待核查';
  $('#scope-note').textContent=redis?'✓　仅修改选定的一个 Key':'✓　按主键定位一行';
  $('#object-label').textContent=redis?'键空间':'数据表';
  $('#change-label').textContent=redis?'修改参数':'修改字段';
  $('#forward-label').textContent=redis?'执行命令':'执行 SQL';$('#rollback-label').textContent=redis?'恢复命令':'回滚 SQL';
  $('#redis-action').hidden=!redis;$('#redis-action-label').hidden=!redis;$('#redis-controls').hidden=!redis;
  $('#changes').value='{}';$('#redis-action').replaceChildren(el('option','请先选择 Key'));$('#redis-action').disabled=true;
  ['.editor-heading','.editor','.query-actions'].forEach(selector=>$(selector).hidden=redis);
  document.querySelector('[data-view="query"]').textContent=redis?'Key 浏览器':'查询与数据';
  document.querySelector('[data-view="structure"]').hidden=redis;
  document.querySelector('[data-view="query"]').click();
  $('#breadcrumb').textContent=redis?'Key 浏览器':'';
  $('#connection-test').disabled=connection.engine==='sqlite';
  await schema();
  if(redis || state.table) { await browse(); if(!redis) setDefaultSql(); }
  else $('#result').replaceChildren(el('div','当前数据库中没有可浏览的数据表','empty'));
  $('#breadcrumb').textContent=redis?'Key 浏览器':state.table;
  await plans();await audit();$('#status').textContent='连接已就绪';
}
$('#connection-select').onchange=()=>{const id=$('#connection-select').value;selectConnection(id).catch(error=>{if(state.connection.id!==id)return;$('#query-error').textContent=error.message;$('#query-error').hidden=false;$('#result').replaceChildren(el('div','连接读取失败，请检查配置后重试。','empty'));toast(error.message);});};
$('#connection-add').onclick=()=>{ $('#connection-error').hidden=true;$('#connection-dialog').showModal(); };
$('#connection-cancel').onclick=()=>$('#connection-dialog').close();
$('#new-engine').onchange=()=>{const redis=$('#new-engine').value==='redis';$('#new-port').value=redis?'6379':'3306';$('#new-database').value=redis?'0':'';$('#database-label').textContent=redis?'Redis DB 编号':'数据库名称';};
$('#new-environment').onchange=()=>{const production=$('#new-environment').value==='production';$('#new-writes').disabled=production;if(production)$('#new-writes').checked=false;};
$('#connection-form').onsubmit=e=>{e.preventDefault();action($('#connection-save'),$('#connection-error'),async()=>{
  const form=new FormData($('#connection-form'));const data=Object.fromEntries(form);data.port=Number(data.port);data.tls=form.has('tls');data.allowWrites=form.has('allowWrites');
  const result=await api('connections',data);$('#connection-form').reset();$('#connection-dialog').close();await loadConnections();
  await selectConnection(result.connection.id);toast('连接已保存，读取结果已记录。');
});};
$('#connection-test').onclick=()=>action($('#connection-test'),$('#query-error'),async()=>{const result=await api(`connections/${state.connection.id}/test`,{});toast(`${result.engine.toUpperCase()} ${result.version} 连接成功`);});
$('#redis-controls').onsubmit=e=>{e.preventDefault();const button=$('#redis-controls button');action(button,$('#query-error'),()=>browse());};
Object.assign(errors,{HASH_FIELD_TTL_UNSUPPORTED:'此 Hash 存在字段级过期时间，当前版本不支持对此类 Key 执行可回滚变更。',BINARY_VALUE_UNSUPPORTED:'此 Key 含二进制值，当前内容面板仅支持 UTF-8 文本。',QUERY_BUSY:'当前并发操作已达上限，请稍后再试。',CONNECTION_FAILED:'连接失败，请检查主机、端口、账号与证书。',CONNECTION_READ_ONLY:'当前连接仅允许读取。',TRIGGER_VISIBILITY_REQUIRED:'变更账号需要具备目标表的 TRIGGER 元数据可见权限，才能检查回滚是否可靠。',KEY_TOO_LARGE:'此 Key 超过安全编辑上限（1 MiB 或 1000 个元素），请缩小处理范围。',ROLLBACK_EXPIRED:'原数据的过期时间已到，已拒绝恢复以避免复活过期 Key。',OUTCOME_UNKNOWN:'远程执行结果待核查，已禁止直接重试。请读取当前数据并对照计划快照。',REDIS_ERROR:'Redis 操作失败，请检查连接、版本和 ACL 权限。',REDIS_7_REQUIRED:'此面板需要 Redis 7 或更新版本。',CURSOR_EXPIRED:'分页游标已过期，请从首页重新扫描。',COLUMN_ALIASES_REQUIRED:'查询结果存在重名列，请为字段添加不同别名。',SINGLE_PRIMARY_KEY_REQUIRED:'自动浏览需要单列主键；此表请使用只读 SQL 查询。'});
try { await loadConnections(); const saved=localStorage.getItem('tongyun-connection');await selectConnection(state.connections.some(c=>c.id===saved)?saved:'local-sqlite'); } catch (error) { $('#query-error').textContent = error.message; $('#query-error').hidden = false; }
setInterval(() => { const id=state.connection.id;if (document.visibilityState === 'visible') Promise.all([plans(), ...(viewingOlderAudit ? [] : [audit()])]).catch(() => { if(state.connection.id===id)$('#status').textContent = '连接暂时不可用，请刷新'; }); }, 10000);
