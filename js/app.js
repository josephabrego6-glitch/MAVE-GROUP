(function(){
  "use strict";

  /* Si la librería de Supabase no cargó, avisar en vez de quedarse mudo */
  if(!window.supabase){
    document.getElementById('loginForm').addEventListener('submit', function(e){ e.preventDefault(); });
    const le = document.getElementById('loginError');
    le.textContent = 'No se pudo conectar con Supabase. Abre este archivo desde tu computador con internet (no desde la vista previa del chat).';
    le.style.display = 'block';
    return;
  }

  /* ===================== SUPABASE CLIENT ===================== */
  const SUPABASE_URL = 'https://aagsotpxkvjeblmbcbtd.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_l7d_aPCwLSU8mdBv2jCQnQ_xAYNmWW9';
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let products = [];
  let sales = [];
  let salePayments = [];
  let expenses = [];

  function todayLocal(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
  function fmtUSD(n){ n = Number(n)||0; return '$' + n.toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2}); }
  function fmtMXN(n){ n = Number(n)||0; return '$' + n.toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2}) + ' MXN'; }
  function escapeHtml(str){ const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

  let toastTimer = null;
  function showToast(msg){
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=> t.classList.remove('show'), 2600);
  }

  /* ===================== ROW <-> OBJECT MAPPERS ===================== */
  function rowToProduct(r){
    return { id:r.id, photo:r.photo||'', name:r.name, desc:r.description||'', precioMXN:Number(r.precio_mxn), tasa:Number(r.tasa), exportCost:Number(r.export_cost), costoUSD:Number(r.costo_usd), ventaUSD:Number(r.venta_usd), stock:Number(r.stock), personal:!!r.personal_use };
  }
  function productToRow(p){
    return { photo:p.photo||null, name:p.name, description:p.desc||null, precio_mxn:p.precioMXN, tasa:p.tasa, export_cost:p.exportCost, costo_usd:p.costoUSD, venta_usd:p.ventaUSD, stock:p.stock, personal_use:!!p.personal };
  }
  function rowToSale(r){
    return { id:r.id, productId:r.product_id, productName:r.product_name, client:r.client, qty:Number(r.qty), date:r.date, totalUSD:Number(r.total_usd), costoUnitario:Number(r.costo_unitario), profitUSD:Number(r.profit_usd), paymentType:r.payment_type, phone:r.contact_phone, advisor:r.advisor, orderId:r.order_id || null };
  }
  function saleToRow(s){
    return { product_id:s.productId, product_name:s.productName, client:s.client, qty:s.qty, date:s.date, total_usd:s.totalUSD, costo_unitario:s.costoUnitario, profit_usd:s.profitUSD };
  }
  function rowToExpense(r){
    return { id:r.id, desc:r.description, date:r.date, amountUSD:Number(r.amount_usd) };
  }
  function expenseToRow(e){
    return { description:e.desc, date:e.date, amount_usd:e.amountUSD };
  }
  /* ===================== DATA LOADING ===================== */
  async function fetchProducts(){
    const {data, error} = await sb.from('products').select('*').order('created_at', {ascending:true});
    if(error){ console.error(error); showToast('No se pudo cargar el inventario.'); return []; }
    return data.map(rowToProduct);
  }
  async function fetchSales(){
    const {data, error} = await sb.from('sales').select('*').order('created_at', {ascending:false});
    if(error){ console.error(error); showToast('No se pudo cargar el historial de ventas.'); return []; }
    return data.map(rowToSale);
  }
  async function fetchSalePayments(){
    const {data, error} = await sb.from('sale_payments').select('*').order('number', {ascending:true});
    if(error){ console.error(error); return []; }
    return data.map(r=>({ id:r.id, saleId:r.sale_id, number:r.number, due:r.due_date, amount:Number(r.amount), paid:r.paid }));
  }
  async function fetchExpenses(){
    const {data, error} = await sb.from('expenses').select('*').order('created_at', {ascending:false});
    if(error){ console.error(error); showToast('No se pudo cargar los gastos.'); return []; }
    return data.map(rowToExpense);
  }
  async function refreshAllData(){
    [products, sales, expenses, salePayments] = await Promise.all([fetchProducts(), fetchSales(), fetchExpenses(), fetchSalePayments()]);
    await fetchImportData();
    await fetchSecurity();
  }
  function renderRowsIfIdle(){ if(!document.activeElement || !impForm.contains(document.activeElement)) renderImpRows(); }
  function renderAll(){
    renderInventory(); renderSaleProductOptions(); renderSales(); renderAdvisorChart(); renderPayBanner(); renderCobros(); renderExpenses();
    renderImports(); renderRowsIfIdle(); renderSecurity(); renderDashboard();
  }

  /* ===================== IMPORTACIONES ===================== */
  let currencies = [], imports = [], impItems = [], impCosts = [], supOrders = [];
  let impF = { items: [], costs: [], orders: [] };
  let impUid = 0;
  const newImpItem = ()=>({pid:'',name:'',qty:1,price:0,venta:0,ok:'',iname:'',rec:'',gift:false});
  const newImpOrder = ()=>({key:'n'+(++impUid), ref:'', date:'', dtype:'monto', dval:0, fee:0, base:'antes_descuento', round:true, total:'', note:''});
  let impEditId = null;
  const COST_LABEL = { bodega:'Bodega', proveedor:'Cargo fijo del proveedor', envio:'Envío', otro:'Otro' };
  const PAY_LABEL = { contado:'Contado', ach:'ACH', paypal:'PayPal', tarjeta:'Tarjeta' };
  const rateCache = {};

  async function fetchImportData(){
    const [c, i, it, co, so] = await Promise.all([
      sb.from('currencies').select('*').order('code'),
      sb.from('imports').select('*').order('number', {ascending:false}),
      sb.from('import_items').select('*'), sb.from('import_costs').select('*'),
      sb.from('supplier_orders').select('*').order('order_ref')
    ]);
    currencies = c.data || []; imports = i.data || []; impItems = it.data || []; impCosts = co.data || []; supOrders = so.data || [];
  }
  function curLabel(c){ return c.code + ' — ' + c.name + (c.countries ? ' (' + c.countries + ')' : ''); }
  function parseCur(v){
    const code = String(v||'').trim().split(/\s|—/)[0].toUpperCase();
    return currencies.some(c=>c.code === code) ? code : null;
  }
  async function fetchRate(code){
    if(code === 'USD') return 1;
    if(!rateCache.t){
      try{ const r = await fetch('https://open.er-api.com/v6/latest/USD'); rateCache.t = (await r.json()).rates || {}; }
      catch(e){ rateCache.t = {}; }
    }
    return rateCache.t[code] || null;
  }
  // misma fórmula que la base de datos (compute_import_landed)
  function calcImport(h, items, costs, orders){
    orders = orders || [];
    const f = h.taxIncl ? 1 : 1 + h.taxPct/100;
    const units = items.reduce((a,i)=>a + i.qty, 0);
    const ot = {};
    orders.forEach(o=>{
      const sub = items.filter(i=>i.ok === o.key).reduce((a,i)=>a + i.qty*i.price, 0);
      const dRaw = o.dtype === 'porcentaje' ? sub*o.dval/100 : o.dval;
      const disc = sub > 0 ? Math.min(sub, Math.max(0, dRaw)) : 0;
      const fraw = (o.base === 'despues_descuento' ? sub - disc : sub) * o.fee / 100;
      const fee = o.round ? Math.round(fraw) : fraw;
      ot[o.key] = { key:o.key, sub:sub, disc:disc, fee:fee, calc:sub - disc + fee };
    });
    const lines = items.map(i=>{
      const t = ot[i.ok];
      const net = (t && t.sub > 0) ? i.price*(1 - t.disc/t.sub) : i.price;
      const feeU = (t && t.sub > 0) ? t.fee*i.price/t.sub : 0;
      return { net:net, feeU:feeU, wt:net*f + feeU };
    });
    const totalWt = items.reduce((a,i,k)=>a + i.qty*lines[k].wt, 0);
    const extras = costs.reduce((a,c)=>a + (c.rate > 0 ? c.amount / c.rate : 0), 0);
    const rows = items.map((i,k)=>{
      const alloc = (h.alloc === 'valor' && totalWt > 0) ? extras*lines[k].wt/totalWt : (units ? extras/units : 0);
      return h.rate > 0 ? (lines[k].wt + i.price*h.comm/100)/h.rate + alloc : 0;
    });
    return { rows, extras, total: rows.reduce((a,u,k)=>a + u*items[k].qty, 0), orders: Object.values(ot) };
  }
  function readImpHeader(){
    const v = id => document.getElementById(id).value;
    return { date:v('impDate'), supplier:v('impSupplier').trim(), country:v('impCountry').trim(), pay:v('impPay'),
      cur:parseCur(v('impCurrency')), rate:Number(v('impRate'))||0, taxPct:Number(v('impTaxPct'))||0,
      taxIncl:v('impTaxIncl') === '1', comm:Number(v('impComm'))||0, alloc:v('impAlloc') };
  }
  function resetImpForm(){
    impEditId = null;
    impF = { items:[newImpItem()], costs:[], orders:[] };
    document.querySelector('#view-importaciones h2').textContent = 'Nueva importación';
    document.getElementById('impSaveDraft').textContent = 'Guardar borrador';
    document.getElementById('impForm').reset();
    document.getElementById('impDate').value = todayLocal();
    renderImpRows(); refreshImpPreview();
  }
  // compara sin mayúsculas, sin tildes y sin espacios repetidos
  function normText(s){
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
  }
  // Nombres usados con este proveedor en importaciones YA RECIBIDAS (no borradores),
  // con la fecha y el precio de la última vez que se compró cada uno.
  function supplierCatalog(supplier){
    const s = normText(supplier);
    if(!s) return [];
    const found = {};
    imports.forEach(im=>{
      if(im.status !== 'recibida' || normText(im.supplier) !== s) return;
      impItems.filter(x=>x.import_id === im.id).forEach(x=>{
        const name = String(x.product_name || '').trim();
        if(!name) return;
        const key = normText(name);
        const prev = found[key];
        if(!prev || String(im.date) > String(prev.date) || (String(im.date) === String(prev.date) && im.number > prev.number)){
          found[key] = { name:name, date:im.date, price:Number(x.unit_price)||0, currency:im.currency };
        }
      });
    });
    return Object.values(found).sort((a,b)=>a.name.localeCompare(b.name,'es'));
  }

  function refreshImpProductCatalog(){
    const list = document.getElementById('impProductCatalog');
    if(!list) return;
    list.innerHTML = supplierCatalog(document.getElementById('impSupplier').value).map(e=>
      '<option value="'+escapeHtml(e.name)+'" label="'+escapeHtml(e.name+' · última vez '+e.date+' · '+e.price+' '+e.currency)+'"></option>').join('');
  }

  function renderImpRows(){
    refreshImpProductCatalog();
    const ordLabel = (o,n)=>(o.ref ? '#'+o.ref : 'Pedido '+(n+1));
    document.querySelector('#impOrdersTbl tbody').innerHTML = impF.orders.map((o,i)=>
      '<tr data-i="'+i+'"><td><input data-k="ref" type="text" value="'+escapeHtml(o.ref)+'" style="width:90px" placeholder="90734"></td>'+
      '<td><input data-k="date" type="date" value="'+escapeHtml(o.date)+'"></td>'+
      '<td><select data-k="dtype"><option value="monto"'+(o.dtype==='monto'?' selected':'')+'>Monto</option><option value="porcentaje"'+(o.dtype==='porcentaje'?' selected':'')+'>%</option></select></td>'+
      '<td><input data-k="dval" type="number" min="0" step="any" value="'+o.dval+'" style="width:90px"></td>'+
      '<td><input data-k="fee" type="number" min="0" step="any" value="'+o.fee+'" style="width:70px"></td>'+
      '<td><select data-k="base"><option value="antes_descuento"'+(o.base==='antes_descuento'?' selected':'')+'>Subtotal sin descuento</option><option value="despues_descuento"'+(o.base==='despues_descuento'?' selected':'')+'>Subtotal con descuento</option></select></td>'+
      '<td><input data-k="round" type="checkbox"'+(o.round?' checked':'')+'></td>'+
      '<td><input data-k="total" type="number" min="0" step="any" value="'+escapeHtml(o.total)+'" style="width:110px"></td>'+
      '<td><input data-k="note" type="text" value="'+escapeHtml(o.note)+'" placeholder="Ej. correo del proveedor"></td>'+
      '<td><button type="button" class="link-btn danger" data-rmo="'+i+'">Quitar</button></td></tr>').join('');
    document.querySelector('#impItemsTbl tbody').innerHTML = impF.items.map((r,i)=>
      '<tr data-i="'+i+'"><td><select data-k="pid"><option value="">Producto nuevo</option>'+
      products.map(p=>'<option value="'+p.id+'"'+(p.id===r.pid?' selected':'')+'>'+escapeHtml(p.name)+'</option>').join('')+'</select></td>'+
      '<td><input data-k="name" list="impProductCatalog" type="text" value="'+escapeHtml(r.name)+'"'+(r.pid?' disabled':'')+' placeholder="Ej. Coco negra"></td>'+
      '<td><select data-k="ok"><option value="">—</option>'+impF.orders.map((o,n)=>'<option value="'+o.key+'"'+(o.key===r.ok?' selected':'')+'>'+escapeHtml(ordLabel(o,n))+'</option>').join('')+'</select></td>'+
      '<td><input data-k="iname" type="text" value="'+escapeHtml(r.iname)+'" placeholder="Como aparece en la factura"></td>'+
      '<td><input data-k="qty" type="number" min="1" step="1" value="'+r.qty+'" style="width:70px"></td>'+
      '<td><input data-k="rec" type="number" min="0" step="1" value="'+escapeHtml(r.rec)+'" style="width:70px" placeholder="= cant."></td>'+
      '<td><input data-k="price" type="number" min="0" step="any" value="'+r.price+'" style="width:100px"></td>'+
      '<td><input data-k="venta" type="number" min="0" step="any" value="'+r.venta+'" style="width:90px"></td>'+
      '<td><input data-k="gift" type="checkbox"'+(r.gift?' checked':'')+'></td>'+
      '<td><button type="button" class="link-btn danger" data-rm="'+i+'">Quitar</button></td></tr>').join('');
    document.querySelector('#impCostsTbl tbody').innerHTML = impF.costs.map((r,i)=>
      '<tr data-i="'+i+'"><td><select data-k="kind">'+Object.keys(COST_LABEL).map(k=>'<option value="'+k+'"'+(k===r.kind?' selected':'')+'>'+COST_LABEL[k]+'</option>').join('')+'</select></td>'+
      '<td><input data-k="desc" type="text" value="'+escapeHtml(r.desc)+'"></td>'+
      '<td><input data-k="amount" type="number" min="0" step="any" value="'+r.amount+'" style="width:110px"></td>'+
      '<td><input data-k="cur" type="text" list="currencyList" value="'+escapeHtml(r.cur)+'" style="width:150px" autocomplete="off"></td>'+
      '<td><input data-k="rate" type="number" min="0" step="any" value="'+r.rate+'" style="width:100px"></td>'+
      '<td><button type="button" class="link-btn danger" data-rmc="'+i+'">Quitar</button></td></tr>').join('');
  }
  function impOrdersNum(){
    return impF.orders.map(o=>({ key:o.key, dtype:o.dtype, dval:Number(o.dval)||0, fee:Number(o.fee)||0, base:o.base, round:!!o.round }));
  }
  function refreshImpPreview(){
    const h = readImpHeader();
    const items = impF.items.filter(r=>r.qty > 0 && (r.pid || r.name.trim()));
    const costs = impF.costs.map(c=>({ amount:Number(c.amount)||0, rate:Number(c.rate)||0 }));
    const el = document.getElementById('impPreview');
    if(!items.length || !h.rate){ el.innerHTML = 'Completa la moneda, la tasa y al menos un producto para ver el costo.'; return; }
    const r = calcImport(h, items.map(i=>({qty:Number(i.qty), price:Number(i.price)||0, ok:i.ok})), costs, impOrdersNum());
    const ordTxt = r.orders.map(t=>{
      const o = impF.orders.find(x=>x.key === t.key), n = impF.orders.indexOf(o);
      const inv = o.total === '' ? null : Number(o.total), d = inv === null ? null : Math.round((t.calc - inv)*100)/100;
      return '<br>Pedido '+escapeHtml(o.ref ? '#'+o.ref : String(n+1))+': subtotal '+t.sub.toFixed(2)+' − descuento '+t.disc.toFixed(2)+' + cargo '+t.fee.toFixed(2)+' = <b>'+t.calc.toFixed(2)+' '+(h.cur||'')+'</b>'+
        (d === null ? '' : (d === 0 ? ' · <span class="pos">cuadra con la factura</span>' : ' · <span class="neg">diferencia de '+d.toFixed(2)+' con la factura ('+inv.toFixed(2)+')</span>'));
    }).join('');
    el.innerHTML = 'Costo unitario USD: ' + items.map((i,k)=>escapeHtml((i.pid ? (products.find(p=>p.id===i.pid)||{}).name : i.name) || '—')+' <b>'+fmtUSD(r.rows[k])+'</b>').join(' · ') +
      '<br>Costos adicionales: <b>'+fmtUSD(r.extras)+'</b> · Total de la importación: <b>'+fmtUSD(r.total)+'</b>'+ordTxt;
  }

  const impForm = document.getElementById('impForm');
  impForm.addEventListener('input', function(e){
    if(e.target.id === 'impSupplier'){ refreshImpProductCatalog(); return; }
    const k = e.target.dataset.k, tr = e.target.closest('tr');
    if(k && tr){
      const list = tr.closest('#impCostsTbl') ? impF.costs : tr.closest('#impOrdersTbl') ? impF.orders : impF.items, row = list[Number(tr.dataset.i)];
      row[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    }
    refreshImpPreview();
  });
  impForm.addEventListener('change', async function(e){
    const k = e.target.dataset.k, tr = e.target.closest('tr');
    if(e.target.id === 'impCurrency'){
      const code = parseCur(e.target.value);
      if(code){ e.target.value = code; const r = await fetchRate(code); if(r) document.getElementById('impRate').value = r; else showToast('No se pudo obtener la tasa; escríbela a mano.'); }
      refreshImpPreview(); return;
    }
    if(!k || !tr) return;
    const i = Number(tr.dataset.i);
    if(tr.closest('#impOrdersTbl')){ renderImpRows(); refreshImpPreview(); return; }
    if(tr.closest('#impItemsTbl') && k === 'pid'){
      impF.items[i].pid = e.target.value;
      const p = products.find(x=>x.id === e.target.value);
      impF.items[i].name = p ? p.name : '';
      if(p && !Number(impF.items[i].venta)) impF.items[i].venta = p.ventaUSD;
      renderImpRows();
    } else if(tr.closest('#impCostsTbl') && k === 'cur'){
      const code = parseCur(e.target.value);
      impF.costs[i].cur = code || e.target.value;
      if(code){ const r = await fetchRate(code); if(r) impF.costs[i].rate = r; }
      renderImpRows();
    }
    refreshImpPreview();
  });
  impForm.addEventListener('click', function(e){
    if(e.target.dataset.rm !== undefined){ impF.items.splice(Number(e.target.dataset.rm), 1); if(!impF.items.length) impF.items.push(newImpItem()); renderImpRows(); refreshImpPreview(); }
    if(e.target.dataset.rmo !== undefined){
      const o = impF.orders.splice(Number(e.target.dataset.rmo), 1)[0];
      impF.items.forEach(r=>{ if(o && r.ok === o.key) r.ok = ''; });
      renderImpRows(); refreshImpPreview();
    }
    if(e.target.dataset.rmc !== undefined){ impF.costs.splice(Number(e.target.dataset.rmc), 1); renderImpRows(); refreshImpPreview(); }
  });
  document.getElementById('impAddItem').addEventListener('click', ()=>{ impF.items.push(newImpItem()); renderImpRows(); });
  document.getElementById('impAddOrder').addEventListener('click', ()=>{ impF.orders.push(newImpOrder()); renderImpRows(); });
  document.getElementById('impAddCost').addEventListener('click', ()=>{ impF.costs.push({kind:'bodega',desc:'',amount:0,cur:'',rate:0}); renderImpRows(); });

  // evita guardar dos veces si se pulsa dos veces o Enter + clic (duplicaba productos)
  let impSaving = false;
  async function saveImport(receive){
    if(impSaving) return;
    impSaving = true;
    const btns = Array.from(impForm.querySelectorAll('button'));
    btns.forEach(b=>{ b.disabled = true; });
    try{ await saveImportCore(receive); }
    finally{ impSaving = false; btns.forEach(b=>{ b.disabled = false; }); }
  }
  async function saveImportCore(receive){
    const h = readImpHeader();
    if(!h.cur){ showToast('Elige una moneda de la lista.'); return; }
    if(!(h.rate > 0)){ showToast('Indica la tasa de cambio.'); return; }
    const items = impF.items.filter(r=>r.pid || r.name.trim());
    if(!items.length){ showToast('Agrega al menos un producto.'); return; }
    if(items.some(r=>!(Number(r.qty) >= 1))){ showToast('Revisa las cantidades.'); return; }
    const costs = impF.costs.filter(c=>Number(c.amount) > 0);
    for(const c of costs){ if(!parseCur(c.cur) || !(Number(c.rate) > 0)){ showToast('Cada costo adicional necesita moneda y tasa.'); return; } }

    let imp, error;
    const payload = {
      date:h.date || todayLocal(), supplier:h.supplier || null, origin_country:h.country || null, currency:h.cur, rate_per_usd:h.rate,
      commission_pct:h.comm, tax_pct:h.taxPct, tax_included:h.taxIncl, allocation:h.alloc, payment_method:h.pay,
      purchase_date:document.getElementById('impPurchase').value || null
    };

    if(impEditId){
      const res = await sb.from('imports').update(payload).eq('id', impEditId).eq('status','borrador').select().single();
      imp = res.data; error = res.error;
      if(!error && !imp){ error = { message:'El borrador ya no está disponible para editar.' }; }
    } else {
      const res = await sb.from('imports').insert(payload).select().single();
      imp = res.data; error = res.error;
    }
    if(error){ console.error(error); showToast(error.message || 'No se pudo guardar la importación.'); return; }

    if(impEditId){
      const d1 = await sb.from('import_items').delete().eq('import_id', imp.id);
      const d2 = await sb.from('import_costs').delete().eq('import_id', imp.id);
      const d3 = d1.error ? {} : await sb.from('supplier_orders').delete().eq('import_id', imp.id);
      if(d1.error || d2.error || d3.error){ console.error(d1.error || d2.error || d3.error); showToast('No se pudo actualizar el detalle del borrador.'); return; }
    }

    // pedidos del proveedor: se crean primero para poder enlazar cada producto
    const orderId = {};
    for(const o of impF.orders){
      const res = await sb.from('supplier_orders').insert({ import_id:imp.id, order_ref:o.ref.trim() || null, order_date:o.date || null,
        discount_type:o.dtype, discount_value:Number(o.dval)||0, fee_pct:Number(o.fee)||0, fee_base:o.base, fee_rounding:!!o.round,
        invoice_total:o.total === '' ? null : Number(o.total), invoice_ref:o.note.trim() || null }).select().single();
      if(res.error){ console.error(res.error); showToast('No se pudo guardar un pedido del proveedor.'); return; }
      orderId[o.key] = res.data.id;
    }

    const e1 = await sb.from('import_items').insert(items.map(r=>({ import_id:imp.id, product_id:r.pid || null,
      product_name:(r.pid ? (products.find(p=>p.id===r.pid)||{}).name : r.name.trim()), qty:Number(r.qty), unit_price:Number(r.price)||0, venta_usd:Number(r.venta)||0,
      supplier_order_id:orderId[r.ok] || null, invoice_name:r.iname.trim() || null, is_gift:!!r.gift,
      qty_received:String(r.rec).trim() === '' ? null : Number(r.rec) })));
    const e2 = costs.length ? await sb.from('import_costs').insert(costs.map(c=>({ import_id:imp.id, kind:c.kind, description:c.desc || null,
      amount:Number(c.amount), currency:parseCur(c.cur), rate_per_usd:Number(c.rate) }))) : {};
    if(e1.error || e2.error){ console.error(e1.error || e2.error); showToast('No se pudo guardar los productos o costos.'); return; }

    if(receive){
      const { error: re } = await sb.rpc('receive_import', { p_import: imp.id });
      if(re){ console.error(re); showToast(re.message || 'Se guardó como borrador, pero no se pudo recibir.'); }
      else showToast(impEditId ? 'Borrador actualizado y recibido: inventario actualizado.' : 'Importación recibida: inventario actualizado.');
    } else showToast(impEditId ? 'Borrador actualizado.' : 'Borrador guardado.');
    await refreshAllData(); resetImpForm(); renderAll();
  }
  impForm.addEventListener('submit', e=>{ e.preventDefault(); saveImport(true); });
  document.getElementById('impSaveDraft').addEventListener('click', ()=>saveImport(false));


  // Vista de solo lectura: muestra cómo quedó llenada una importación, sin modificar nada
  function showImpDetail(id){
    const im = imports.find(x=>x.id === id), box = document.getElementById('impDetail');
    if(!im) return;
    const its = impItems.filter(x=>x.import_id === id), cs = impCosts.filter(x=>x.import_id === id), sos = supOrders.filter(x=>x.import_id === id);
    const n2 = v => (Math.round(Number(v||0)*100)/100).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    const calc = calcImport({ rate:Number(im.rate_per_usd), taxPct:Number(im.tax_pct), taxIncl:im.tax_included, comm:Number(im.commission_pct), alloc:im.allocation },
      its.map(x=>({qty:x.qty, price:Number(x.unit_price), ok:x.supplier_order_id || ''})), cs.map(c=>({amount:Number(c.amount), rate:Number(c.rate_per_usd)})),
      sos.map(o=>({key:o.id, dtype:o.discount_type, dval:Number(o.discount_value)||0, fee:Number(o.fee_pct)||0, base:o.fee_base, round:!!o.fee_rounding})));
    const unit = (x,k)=> im.status === 'recibida' ? Number(x.landed_unit_cost_usd||0) : calc.rows[k];
    const totalUsd = its.reduce((a,x,k)=>a + (im.status === 'recibida' ? (x.qty_received ?? x.qty) : x.qty)*unit(x,k), 0);
    const ordName = id2 => { const o = sos.find(z=>z.id === id2); return o ? (o.order_ref ? '#'+o.order_ref : 'Pedido') : '—'; };
    const th = arr => '<thead><tr>'+arr.map(t=>'<th>'+t+'</th>').join('')+'</tr></thead>';
    let h = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;"><h2 style="margin:0;">Importación #'+im.number+' · '+(im.status === 'recibida' ? 'Recibida' : 'Borrador')+' <small>(solo lectura)</small></h2><button type="button" class="link-btn" id="impDetailClose">Cerrar</button></div>';
    h += '<p class="empty" style="display:block;margin:8px 0;">'+[
      'Fecha: '+im.date, im.purchase_date ? 'Compra: '+im.purchase_date : '', 'Proveedor: '+escapeHtml(im.supplier||'—'), im.origin_country ? 'País: '+escapeHtml(im.origin_country) : '',
      'Moneda: '+im.currency+' (tasa '+Number(im.rate_per_usd)+')', 'Pago: '+(PAY_LABEL[im.payment_method]||'—'),
      'Impuesto: '+Number(im.tax_pct)+'% '+(im.tax_included ? '(incluido)' : '(se suma)'), 'Cargo del proveedor: '+Number(im.commission_pct)+'%',
      'Reparto de costos: '+(im.allocation === 'valor' ? 'según valor' : 'igual por unidad')].filter(Boolean).join(' · ')+'</p>';
    if(sos.length){
      h += '<h3 style="margin:14px 0 6px;">Pedidos del proveedor</h3><div style="overflow-x:auto;"><table>'+th(['Pedido','Fecha','Subtotal','Descuento','Cargo','Total calculado','Factura','Diferencia','Reembolso','Origen / notas'])+'<tbody>'+
        sos.map(o=>{
          const t = calc.orders.find(z=>z.key === o.id) || {sub:0,disc:0,fee:0,calc:0};
          const d = o.invoice_total === null ? null : Math.round((t.calc - Number(o.invoice_total))*100)/100;
          return '<tr><td data-label="Pedido">'+escapeHtml(o.order_ref ? '#'+o.order_ref : '—')+'</td><td data-label="Fecha">'+(o.order_date||'')+'</td><td data-label="Subtotal">'+n2(t.sub)+'</td>'+
            '<td data-label="Descuento">'+n2(t.disc)+(o.discount_type === 'porcentaje' ? ' <small>('+Number(o.discount_value)+'%)</small>' : '')+'</td>'+
            '<td data-label="Cargo">'+n2(t.fee)+' <small>('+Number(o.fee_pct)+'% '+(o.fee_base === 'despues_descuento' ? 'con descuento' : 'sin descuento')+')</small></td><td data-label="Total calculado"><b>'+n2(t.calc)+'</b></td>'+
            '<td data-label="Factura">'+(o.invoice_total === null ? '—' : n2(o.invoice_total))+'</td>'+
            '<td data-label="Diferencia">'+(d === null ? '—' : d === 0 ? '<span class="pos">Cuadra</span>' : '<span class="neg">'+n2(d)+'</span>')+'</td>'+
            '<td data-label="Reembolso">'+(Number(o.refund_amount) ? n2(o.refund_amount) : '—')+'</td><td data-label="Origen / notas">'+escapeHtml([o.invoice_ref, o.notes].filter(Boolean).join(' — '))+'</td></tr>';
        }).join('')+'</tbody></table></div>';
    }
    h += '<h3 style="margin:14px 0 6px;">Productos</h3><div style="overflow-x:auto;"><table>'+th(['Producto','Nombre en la factura','Pedido','Cant.','Recibida','Precio unit. '+im.currency,'Costo unit. USD','Venta USD','Regalo'])+'<tbody>'+
      its.map((x,k)=>'<tr><td data-label="Producto">'+escapeHtml(x.product_name||'')+'</td><td data-label="Nombre en la factura">'+escapeHtml(x.invoice_name||'')+'</td><td data-label="Pedido">'+escapeHtml(ordName(x.supplier_order_id))+'</td>'+
        '<td data-label="Cant.">'+x.qty+'</td><td data-label="Recibida">'+(x.qty_received ?? x.qty)+'</td><td data-label="Precio unit.">'+n2(x.unit_price)+'</td>'+
        '<td data-label="Costo unit. USD">'+fmtUSD(unit(x,k))+'</td><td data-label="Venta USD">'+(Number(x.venta_usd) ? fmtUSD(x.venta_usd) : '—')+'</td><td data-label="Regalo">'+(x.is_gift ? 'Sí' : '')+'</td></tr>').join('')+'</tbody></table></div>';
    if(cs.length){
      h += '<h3 style="margin:14px 0 6px;">Otros gastos</h3><div style="overflow-x:auto;"><table>'+th(['Tipo','Descripción','Monto','Moneda','Tasa','USD'])+'<tbody>'+
        cs.map(c=>'<tr><td data-label="Tipo">'+(COST_LABEL[c.kind]||c.kind)+'</td><td data-label="Descripción">'+escapeHtml(c.description||'')+'</td><td data-label="Monto">'+n2(c.amount)+'</td><td data-label="Moneda">'+c.currency+'</td><td data-label="Tasa">'+Number(c.rate_per_usd)+'</td><td data-label="USD">'+fmtUSD(Number(c.amount)/Number(c.rate_per_usd))+'</td></tr>').join('')+'</tbody></table></div>';
    }
    h += '<div class="calc-line" style="margin-top:12px;">Costos adicionales: <b>'+fmtUSD(calc.extras)+'</b> · Total de la importación: <b>'+fmtUSD(totalUsd)+'</b></div>';
    if(im.notes) h += '<p class="empty" style="display:block;">Notas: '+escapeHtml(im.notes)+'</p>';
    box.innerHTML = h; box.style.display = 'block';
    document.getElementById('impDetailClose').addEventListener('click', ()=>{ box.style.display = 'none'; });
    box.scrollIntoView({behavior:'smooth'});
  }

  function renderImports(){
    const dl = document.getElementById('currencyList');
    if(dl.children.length !== currencies.length) dl.innerHTML = currencies.map(c=>'<option value="'+escapeHtml(curLabel(c))+'"></option>').join('');
    const tbody = document.querySelector('#tblImp tbody');
    document.getElementById('emptyImp').style.display = imports.length ? 'none' : 'block';
    tbody.innerHTML = imports.map(im=>{
      const its = impItems.filter(x=>x.import_id === im.id), cs = impCosts.filter(x=>x.import_id === im.id), sos = supOrders.filter(x=>x.import_id === im.id);
      const total = im.status === 'recibida' ? its.reduce((a,x)=>a + (x.qty_received ?? x.qty)*Number(x.landed_unit_cost_usd||0), 0) :
        calcImport({ rate:Number(im.rate_per_usd), taxPct:Number(im.tax_pct), taxIncl:im.tax_included, comm:Number(im.commission_pct), alloc:im.allocation },
          its.map(x=>({qty:x.qty, price:Number(x.unit_price), ok:x.supplier_order_id || ''})), cs.map(c=>({amount:Number(c.amount), rate:Number(c.rate_per_usd)})),
          sos.map(o=>({key:o.id, dtype:o.discount_type, dval:Number(o.discount_value)||0, fee:Number(o.fee_pct)||0, base:o.fee_base, round:!!o.fee_rounding}))).total;
      return '<tr><td data-label="#">'+im.number+'</td><td data-label="Fecha">'+im.date+'</td>'+
        '<td data-label="Proveedor">'+escapeHtml(im.supplier||'—')+(im.origin_country ? '<br><small>'+escapeHtml(im.origin_country)+'</small>' : '')+'</td>'+
        '<td data-label="Moneda">'+im.currency+' <small>('+Number(im.rate_per_usd)+')</small></td><td data-label="Pago">'+(PAY_LABEL[im.payment_method]||'')+'</td>'+
        '<td data-label="Prod.">'+its.length+'</td><td data-label="Total USD">'+fmtUSD(total)+'</td>'+
        '<td data-label="Estado">'+(im.status === 'recibida' ? '<span class="pos">Recibida</span>' : 'Borrador')+(sos.length ? '<br><small>'+sos.length+' pedido'+(sos.length>1?'s':'')+' del proveedor</small>' : '')+'</td>'+
        '<td data-label=""><button class="link-btn" data-viewimp="'+im.id+'">Ver</button> '+(im.status === 'borrador' ? '<button class="link-btn" data-editimp="'+im.id+'">Editar</button> <button class="link-btn" data-recv="'+im.id+'">Recibir</button> <button class="link-btn danger" data-delimp="'+im.id+'">Eliminar</button>' : (me && me.role === 'admin' ? '<button class="link-btn danger" data-reopen="'+im.id+'">Reabrir</button>' : ''))+'</td></tr>';
    }).join('');
    tbody.querySelectorAll('[data-editimp]').forEach(b=>b.addEventListener('click', async ()=>{
      const id = b.dataset.editimp;
      const im = imports.find(x=>x.id === id);
      if(!im || im.status !== 'borrador') return;
      const its = impItems.filter(x=>x.import_id === id);
      const cs = impCosts.filter(x=>x.import_id === id);
      impEditId = id;
      document.getElementById('impDate').value = im.date || todayLocal();
      document.getElementById('impSupplier').value = im.supplier || '';
      document.getElementById('impCountry').value = im.origin_country || '';
      document.getElementById('impPay').value = im.payment_method || 'contado';
      document.getElementById('impCurrency').value = im.currency || '';
      document.getElementById('impRate').value = Number(im.rate_per_usd) || '';
      document.getElementById('impTaxPct').value = Number(im.tax_pct) || 0;
      document.getElementById('impTaxIncl').value = im.tax_included ? '1' : '0';
      document.getElementById('impComm').value = Number(im.commission_pct) || 0;
      document.getElementById('impAlloc').value = im.allocation || 'valor';
      const sos = supOrders.filter(x=>x.import_id === id);
      document.getElementById('impPurchase').value = im.purchase_date || '';
      impF = {
        orders: sos.map(o=>({key:o.id, ref:o.order_ref || '', date:o.order_date || '', dtype:o.discount_type, dval:Number(o.discount_value)||0, fee:Number(o.fee_pct)||0,
          base:o.fee_base, round:!!o.fee_rounding, total:o.invoice_total === null ? '' : String(o.invoice_total), note:o.invoice_ref || ''})),
        items: its.map(x=>({pid:x.product_id || '', name:x.product_id ? '' : (x.product_name || ''), qty:Number(x.qty)||1, price:Number(x.unit_price)||0, venta:Number(x.venta_usd)||0,
          ok:x.supplier_order_id || '', iname:x.invoice_name || '', rec:x.qty_received === null || x.qty_received === undefined ? '' : String(x.qty_received), gift:!!x.is_gift})),
        costs: cs.map(x=>({kind:x.kind || 'bodega', desc:x.description || '', amount:Number(x.amount)||0, cur:x.currency || '', rate:Number(x.rate_per_usd)||0}))
      };
      if(!impF.items.length) impF.items = [newImpItem()];
      document.querySelector('#view-importaciones h2').textContent = 'Editar borrador #'+im.number;
      document.getElementById('impSaveDraft').textContent = 'Actualizar borrador';
      renderImpRows(); refreshImpPreview();
      document.getElementById('view-importaciones').scrollIntoView({behavior:'smooth'});
      showToast('Borrador cargado para editar.');
    }));
    tbody.querySelectorAll('[data-recv]').forEach(b=>b.addEventListener('click', async ()=>{
      if(!confirm('¿Recibir esta importación? Se sumará al inventario y ya no podrá editarse.')) return;
      const { error } = await sb.rpc('receive_import', { p_import: b.dataset.recv });
      if(error){ console.error(error); showToast(error.message || 'No se pudo recibir.'); return; }
      await refreshAllData(); renderAll(); showToast('Importación recibida.');
    }));
    tbody.querySelectorAll('[data-viewimp]').forEach(b=>b.addEventListener('click', ()=>showImpDetail(b.dataset.viewimp)));
    tbody.querySelectorAll('[data-reopen]').forEach(b=>b.addEventListener('click', async ()=>{
      if(!confirm('¿Reabrir esta importación para corregirla? Se restará del inventario lo que sumó y volverá a borrador. Después podrás editarla y recibirla otra vez.')) return;
      const { error } = await sb.rpc('reopen_import', { p_import: b.dataset.reopen });
      if(error){ console.error(error); showToast(error.message || 'No se pudo reabrir.'); return; }
      await refreshAllData(); renderAll(); showToast('Importación reabierta como borrador.');
    }));
    tbody.querySelectorAll('[data-delimp]').forEach(b=>b.addEventListener('click', async ()=>{
      if(!confirm('¿Eliminar este borrador?')) return;
      const { error } = await sb.from('imports').delete().eq('id', b.dataset.delimp);
      if(error){ console.error(error); showToast(error.message || 'No se pudo eliminar.'); return; }
      await refreshAllData(); renderAll();
    }));
  }
  resetImpForm();

  /* ===================== SEGURIDAD (admin) ===================== */
  let sec = { alerts:[], requests:[], users:[], allowed:[], logins:[], audit:[], settings:null };
  let lastUnread = null;
  const fmtDT = d => d ? new Date(d).toLocaleString([], {dateStyle:'short', timeStyle:'short'}) : '';
  async function fetchSecurity(){
    if(!me || me.role !== 'admin') return;
    const q = (t, sel, col, n) => sb.from(t).select(sel).order(col, {ascending:false}).limit(n);
    const [a, r, u, al, lg, au, st] = await Promise.all([
      q('alerts','*','created_at',100), q('change_requests','*','created_at',50), sb.from('profiles').select('*').order('email'),
      sb.from('allowed_emails').select('*').order('email'), q('login_events','*','at',40),
      q('audit_log','at,user_email,table_name,action','at',100), sb.from('app_settings').select('*').limit(1)
    ]);
    sec = { alerts:a.data||[], requests:r.data||[], users:u.data||[], allowed:al.data||[], logins:lg.data||[], audit:au.data||[], settings:(st.data||[])[0]||null };
  }
  function updateSecBadge(notify){
    const n = sec.alerts.filter(x=>!x.read_at).length;
    document.getElementById('secBadge').textContent = n ? '(' + n + ')' : '';
    if(notify && lastUnread !== null && n > lastUnread) showToast('Nueva alerta de seguridad.');
    lastUnread = n;
  }
  const SEV = { critical:'🔴 Crítica', warning:'🟠 Aviso', info:'🔵 Info' };
  function renderSecurity(){
    if(!me || me.role !== 'admin') return;
    updateSecBadge(false);
    const T = id => document.querySelector('#'+id+' tbody');
    document.getElementById('emptyAlerts').style.display = sec.alerts.length ? 'none' : 'block';
    T('tblAlerts').innerHTML = sec.alerts.map(a=>'<tr style="'+(a.read_at?'opacity:.55':'font-weight:600')+'"><td>'+fmtDT(a.created_at)+'</td><td>'+(SEV[a.severity]||a.severity)+'</td><td>'+escapeHtml(a.kind)+'</td><td>'+escapeHtml(a.title)+
      (a.detail ? '<br><small>'+escapeHtml(JSON.stringify(a.detail))+'</small>' : '')+'</td><td>'+(a.read_at ? '' : '<button class="link-btn" data-aread="'+a.id+'">Leída</button>')+'</td></tr>').join('');
    document.getElementById('emptyReq').style.display = sec.requests.length ? 'none' : 'block';
    T('tblReq').innerHTML = sec.requests.map(r=>'<tr><td>'+fmtDT(r.created_at)+'</td><td>'+escapeHtml(r.user_email||'')+'</td><td>'+escapeHtml(MOD_NAME[r.module]||r.module)+'</td><td>'+escapeHtml(r.reason||'')+'</td><td>'+r.status+
      (r.expires_at && r.status==='aprobada' ? '<br><small>hasta '+fmtDT(r.expires_at)+'</small>' : '')+'</td><td>'+(r.status==='pendiente' ?
      '<select data-min="'+r.id+'"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="60">1 h</option><option value="120">2 h</option></select> <button class="link-btn" data-aprob="'+r.id+'">Aprobar</button> <button class="link-btn danger" data-deny="'+r.id+'">Denegar</button>' : '')+'</td></tr>').join('');
    T('tblUsers').innerHTML = sec.users.map(u=>{
      const self = u.id === me.id, perms = u.permissions || {};
      return '<tr data-uid="'+u.id+'"><td>'+escapeHtml(u.email||'')+'</td><td><select data-f="role"'+(self?' disabled':'')+'>'+['admin','supervisor','viewer'].map(r=>'<option value="'+r+'"'+(r===u.role?' selected':'')+'>'+({admin:'Administrador',supervisor:'Supervisor',viewer:'Visor'}[r])+'</option>').join('')+'</select></td>'+
        '<td><input type="checkbox" data-f="active"'+(u.active?' checked':'')+(self?' disabled':'')+'></td><td>'+MODULES.map(m=>'<label style="margin-right:8px;white-space:nowrap;"><input type="checkbox" data-m="'+m+'"'+(perms[m]!=='none'?' checked':'')+'> '+MOD_NAME[m]+'</label>').join('')+'</td>'+
        '<td><button class="link-btn" data-saveu="'+u.id+'">Guardar</button></td></tr>';
    }).join('');
    document.getElementById('allowList').innerHTML = sec.allowed.map(x=>'<span style="display:inline-block;margin:0 10px 6px 0;">'+escapeHtml(x.email)+' <button class="link-btn danger" data-rmallow="'+escapeHtml(x.email)+'">Quitar</button></span>').join('');
    T('tblLogins').innerHTML = sec.logins.map(l=>'<tr><td>'+fmtDT(l.at)+'</td><td>'+escapeHtml(l.email||'')+'</td><td>'+(l.success?'✓ Entró':'✗ Falló')+'</td><td>'+escapeHtml(l.ip||'')+'</td><td>'+escapeHtml((l.flags||[]).join(', '))+'</td></tr>').join('');
    T('tblAudit').innerHTML = sec.audit.map(a=>'<tr><td>'+fmtDT(a.at)+'</td><td>'+escapeHtml(a.user_email||'—')+'</td><td>'+escapeHtml(a.table_name)+'</td><td>'+escapeHtml(a.action)+'</td></tr>').join('');
    const st = sec.settings;
    if(st && !document.getElementById('setForm').contains(document.activeElement)){
      document.getElementById('setSale').value = st.large_sale_usd; document.getElementById('setExp').value = st.large_expense_usd;
      document.getElementById('setStock').value = st.stock_change_units; document.getElementById('setNs').value = st.night_start; document.getElementById('setNe').value = st.night_end;
    }
  }
  async function secReload(){ await fetchSecurity(); renderSecurity(); }
  const done = (error, ok) => { if(error){ console.error(error); showToast(error.message || 'No se pudo completar la acción.'); } else showToast(ok); return !error; };
  document.getElementById('view-seguridad').addEventListener('click', async function(e){
    const d = e.target.dataset;
    if(d.aread){ await sb.from('alerts').update({read_at:new Date().toISOString(), read_by:me.id}).eq('id', d.aread); secReload(); }
    if(d.aprob || d.deny){
      const id = d.aprob || d.deny, mins = Number(document.querySelector('[data-min="'+id+'"]').value);
      const { error } = await sb.rpc('decide_request', { p_id:id, p_approve:!!d.aprob, p_minutes:mins });
      if(done(error, d.aprob ? 'Autorización concedida por '+mins+' min.' : 'Solicitud denegada.')) secReload();
    }
    if(d.saveu){
      const tr = e.target.closest('tr'), old = (sec.users.find(u=>u.id===d.saveu)||{}).permissions || {}, perms = {...old};
      tr.querySelectorAll('[data-m]').forEach(c=>{ perms[c.dataset.m] = c.checked ? (old[c.dataset.m] && old[c.dataset.m] !== 'none' ? old[c.dataset.m] : 'view') : 'none'; });
      const upd = { permissions: perms };
      if(d.saveu !== me.id){ upd.role = tr.querySelector('[data-f="role"]').value; upd.active = tr.querySelector('[data-f="active"]').checked; }
      const { error } = await sb.from('profiles').update(upd).eq('id', d.saveu);
      if(done(error, 'Usuario actualizado.')) secReload();
    }
    if(d.rmallow){
      if(!confirm('¿Quitar '+d.rmallow+' de los correos autorizados? (No elimina su cuenta existente.)')) return;
      const { error } = await sb.from('allowed_emails').delete().eq('email', d.rmallow);
      if(done(error, 'Correo quitado.')) secReload();
    }
  });
  document.getElementById('secReadAll').addEventListener('click', async ()=>{ await sb.from('alerts').update({read_at:new Date().toISOString(), read_by:me.id}).is('read_at', null); secReload(); });
  document.getElementById('allowForm').addEventListener('submit', async function(e){
    e.preventDefault();
    const email = document.getElementById('allowEmail').value.trim().toLowerCase();
    const { error } = await sb.from('allowed_emails').insert({ email, added_by: me.id });
    if(done(error, 'Correo autorizado. Ahora crea la cuenta en Supabase.')){ this.reset(); secReload(); }
  });
  document.getElementById('setForm').addEventListener('submit', async function(e){
    e.preventDefault();
    const v = id => Number(document.getElementById(id).value);
    const { error } = await sb.from('app_settings').update({ large_sale_usd:v('setSale'), large_expense_usd:v('setExp'), stock_change_units:v('setStock'), night_start:v('setNs'), night_end:v('setNe') }).eq('id', true);
    if(done(error, 'Umbrales guardados.')) secReload();
  });
  document.querySelector('nav.sidenav [data-view="seguridad"]').addEventListener('click', secReload);
  setInterval(async ()=>{ if(me && me.role === 'admin'){ await fetchSecurity(); updateSecBadge(true); } }, 60000);

  // bloqueo de doble envío en los demás formularios (producto, venta, gasto)
  ['productForm','saleForm','expenseForm'].forEach(id=>{
    const f = document.getElementById(id);
    if(!f) return;
    f.addEventListener('submit', function(e){
      if(f.dataset.busy){ e.preventDefault(); e.stopImmediatePropagation(); return; }
      f.dataset.busy = '1'; setTimeout(()=>{ delete f.dataset.busy; }, 1500);
    }, true);
  });

  /* ===================== LOGIN (Supabase Auth) ===================== */
  const loginScreen = document.getElementById('loginScreen');
  const appEl = document.getElementById('app');

  /* ===================== PERFIL Y PERMISOS ===================== */
  let me = null, authz = {};
  const MODULES = ['inventario','ventas','insumos','importaciones'];
  const MOD_NAME = { inventario:'Inventario', ventas:'Ventas', insumos:'Insumos y gastos', importaciones:'Importaciones' };
  const DENIED_MSG = 'Tu acceso está desactivado o aún no tiene permisos. Contacta al administrador.';
  // ver: admin o permiso distinto de "none"
  function canView(mod){
    if(!me || !me.active) return false;
    if(me.role === 'admin') return true;
    return (me.permissions || {})[mod] !== 'none';
  }
  function canInsert(mod){ return canView(mod) && (me.role === 'admin' || me.role === 'supervisor'); }
  // modificar o eliminar: admin siempre; supervisor solo con autorización vigente
  function canEdit(mod){
    if(!canView(mod)) return false;
    if(me.role === 'admin') return true;
    return me.role === 'supervisor' && !!authz[mod] && authz[mod] > Date.now();
  }
  let denyMsg = DENIED_MSG;
  async function loadProfile(){
    const { data: { user } } = await sb.auth.getUser();
    if(!user) return null;
    const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
    return error ? null : data;
  }
  async function refreshAuthz(){
    if(!me || me.role !== 'supervisor'){ authz = {}; return; }
    const { data } = await sb.from('change_requests').select('module,status,expires_at').eq('user_id', me.id).order('created_at', {ascending:false}).limit(30);
    authz = {}; const pend = [];
    (data || []).forEach(r=>{
      if(r.status === 'aprobada' && r.expires_at && Date.parse(r.expires_at) > Date.now()) authz[r.module] = Math.max(authz[r.module]||0, Date.parse(r.expires_at));
      if(r.status === 'pendiente') pend.push(r.module);
    });
    const bar = document.getElementById('authzBar'), parts = [];
    Object.keys(authz).forEach(m=>parts.push('<b>'+MOD_NAME[m]+'</b> autorizado hasta '+new Date(authz[m]).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})));
    pend.forEach(m=>parts.push('Solicitud pendiente: <b>'+MOD_NAME[m]+'</b>'));
    bar.innerHTML = parts.join(' · '); bar.style.display = parts.length ? 'block' : 'none';
  }
  async function askAuthz(mod){
    const reason = prompt('Para modificar o eliminar en ' + (MOD_NAME[mod]||mod) + ' necesitas la autorización del administrador.\n\nEscribe el motivo y se le enviará la solicitud:');
    if(!reason || !reason.trim()) return;
    const { error } = await sb.rpc('request_change', { p_module: mod, p_reason: reason.trim() });
    showToast(error ? (error.message || 'No se pudo enviar la solicitud.') : 'Solicitud enviada al administrador.');
    refreshAuthz();
  }
  // el supervisor sin autorización no puede editar/eliminar: se le ofrece pedirla
  document.addEventListener('click', function(e){
    if(!me || me.role !== 'supervisor') return;
    const b = e.target.closest('[data-del],[data-edit],[data-delsale],[data-delexp],[data-delped],[data-delimp]');
    if(!b) return;
    const sec = b.closest('section.view'), mod = sec ? sec.id.replace('view-','') : null;
    if(mod && !canEdit(mod)){ e.stopPropagation(); e.preventDefault(); askAuthz(mod); }
  }, true);
  setInterval(()=>{ if(me && me.role === 'supervisor') refreshAuthz(); }, 60000);

  // cierre automático por inactividad (15 min)
  let idleT;
  function bumpIdle(){
    clearTimeout(idleT);
    if(me) idleT = setTimeout(()=>{ document.getElementById('btnLogout').click(); setTimeout(()=>showLoginError('Sesión cerrada por inactividad.'), 900); }, 15*60*1000);
  }
  ['click','keydown','mousemove','touchstart'].forEach(ev=>document.addEventListener(ev, bumpIdle, {passive:true}));

  function applyAccess(){
    MODULES.forEach(m => document.body.classList.toggle('ro-' + m, !canInsert(m)));
    const allowed = {
      dashboard: me.role === 'admin' || (canView('ventas') && canView('insumos')),
      inventario: canView('inventario'),
      ventas: canView('ventas'), cobros: canView('ventas'), insumos: canView('insumos'), importaciones: canView('importaciones'), seguridad: me.role === 'admin'
    };
    let first = null;
    document.querySelectorAll('nav.sidenav button').forEach(btn=>{
      const ok = !!allowed[btn.dataset.view];
      btn.style.display = ok ? '' : 'none';
      if(ok && !first) first = btn;
    });
    if(first) first.click();
  }
  async function startSession(fresh){
    me = await loadProfile();
    if(fresh) await sb.rpc('log_login');
    if(!me || !me.active || !(me.role === 'admin' || MODULES.some(canView))){
      await sb.auth.signOut();
      me = null; denyMsg = DENIED_MSG;
      return false;
    }
    loginScreen.style.display = 'none';
    appEl.style.display = 'block';
    await refreshAuthz();
    applyAccess();
    await bootApp();
    bumpIdle();
    document.getElementById('saleAdvisor').value = me.full_name || '';
    showToast('Bienvenido, ' + (me.full_name || me.email));
    return true;
  }
  function showLoginError(msg){
    const err = document.getElementById('loginError');
    err.textContent = msg; err.style.display = 'block';
  }

  async function checkSession(){
    try{
      const { data: { session } } = await sb.auth.getSession();
      if(session){
        const ok = await startSession();
        if(!ok) showLoginError(denyMsg);
      }
    }catch(e){ console.warn('No se pudo restaurar la sesión', e); }
  }

  /* ===================== VERIFICACIÓN ANTI-ROBOT ===================== */
  // Clave PÚBLICA de Cloudflare Turnstile. Si está vacía se usa una pregunta simple.
  const TURNSTILE_SITE_KEY = '0x4AAAAAAFSAsEvg8cljZyy8';
  let captchaToken = null, captchaAnswer = 0, tsWidget = null;
  function newMathCaptcha(){
    const a = 2 + Math.floor(Math.random() * 8), b = 2 + Math.floor(Math.random() * 8);
    captchaAnswer = a + b;
    document.getElementById('captchaField').innerHTML = '<label for="captchaInput">Verifica que no eres un robot: ¿cuánto es ' + a + ' + ' + b + '?</label>' +
      '<input type="text" inputmode="numeric" id="captchaInput" autocomplete="off" required>';
  }
  function setupCaptcha(){
    if(!TURNSTILE_SITE_KEY){ newMathCaptcha(); return; }
    document.getElementById('captchaField').innerHTML = '<div id="tsBox"></div>';
    const sc = document.createElement('script');
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; sc.async = true;
    sc.onload = () => { tsWidget = window.turnstile.render('#tsBox', { sitekey: TURNSTILE_SITE_KEY,
      callback: t => { captchaToken = t; }, 'expired-callback': () => { captchaToken = null; }, 'error-callback': () => { captchaToken = null; } }); };
    document.head.appendChild(sc);
  }
  function captchaOk(){
    if(TURNSTILE_SITE_KEY) return !!captchaToken;
    const el = document.getElementById('captchaInput');
    return !!el && Number(el.value.trim()) === captchaAnswer;
  }
  function captchaReset(){
    if(TURNSTILE_SITE_KEY){ captchaToken = null; if(window.turnstile && tsWidget !== null) window.turnstile.reset(tsWidget); }
    else newMathCaptcha();
  }
  setupCaptcha();

  document.getElementById('loginForm').addEventListener('submit', async function(e){
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const pass = document.getElementById('loginPass').value;
    const err = document.getElementById('loginError');
    err.style.display = 'none';
    if(!captchaOk()){ showLoginError('Completa la verificación anti-robot.'); captchaReset(); return; }
    const { error } = await sb.auth.signInWithPassword({ email, password: pass, options: TURNSTILE_SITE_KEY ? { captchaToken } : undefined });
    captchaReset();
    if(error){
      sb.rpc('log_failed_login', { p_email: email }).then(()=>{}, ()=>{});
      err.textContent = 'Correo o contraseña incorrectos.';
      err.style.display = 'block';
      return;
    }
    const ok = await startSession(true);
    if(!ok) showLoginError(denyMsg);
  });

  document.getElementById('btnLogout').addEventListener('click', async function(){
    await sb.auth.signOut();
    appEl.style.display = 'none';
    loginScreen.style.display = 'flex';
    document.getElementById('loginForm').reset();
    booted = false;
    me = null; authz = {}; clearTimeout(idleT); captchaReset();
    document.getElementById('authzBar').style.display = 'none';
    MODULES.forEach(m => document.body.classList.remove('ro-' + m));
  });

  /* ===================== CHANGE PASSWORD ===================== */
  const passModal = document.getElementById('passModalOverlay');
  document.getElementById('btnChangePass').addEventListener('click', ()=>{
    document.getElementById('passModalError').style.display = 'none';
    document.getElementById('changePassForm').reset();
    passModal.classList.add('active');
  });
  document.getElementById('passModalCancel').addEventListener('click', ()=> passModal.classList.remove('active'));
  document.getElementById('changePassForm').addEventListener('submit', async function(e){
    e.preventDefault();
    const cur = document.getElementById('curPass').value;
    const next = document.getElementById('newPass').value;
    const errEl = document.getElementById('passModalError');
    const { data: { user } } = await sb.auth.getUser();
    if(!user){ errEl.textContent = 'Sesión no válida.'; errEl.style.display = 'block'; return; }
    const { error: reauthErr } = await sb.auth.signInWithPassword({ email: user.email, password: cur });
    if(reauthErr){
      errEl.textContent = 'La contraseña actual no es correcta.';
      errEl.style.display = 'block';
      return;
    }
    const { error } = await sb.auth.updateUser({ password: next });
    if(error){
      errEl.textContent = 'No se pudo actualizar la contraseña.';
      errEl.style.display = 'block';
      return;
    }
    passModal.classList.remove('active');
    showToast('Contraseña actualizada.');
  });

  /* ===================== NAV ===================== */
  document.querySelectorAll('nav.sidenav button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('nav.sidenav button').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('view-' + btn.dataset.view).classList.add('active');
    });
  });

  /* ===================== IMAGE RESIZE ===================== */
  function resizeImage(file){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = function(ev){
        const img = new Image();
        img.onload = function(){
          const maxDim = 320;
          let w = img.width, h = img.height;
          if(w > h && w > maxDim){ h = Math.round(h * maxDim / w); w = maxDim; }
          else if(h > maxDim){ w = Math.round(w * maxDim / h); h = maxDim; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.72));
        };
        img.onerror = reject;
        img.src = ev.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ===================== PRODUCT FORM ===================== */
  let currentPhotoData = '';
  const photoPreview = document.getElementById('photoPreview');
  /* ===== Recorte de foto: proporción a elección, arrastrar y zoom ===== */
  const cropOverlay = document.getElementById('cropModalOverlay');
  const cropCanvas = document.getElementById('cropCanvas');
  const cropCtx = cropCanvas.getContext('2d');
  const cropZoom = document.getElementById('cropZoom');
  const CROP_OUT = 640;
  const crop = { base:null, ratio:'1', zoom:1, ox:0, oy:0, fw:300, fh:300, box:300, drag:null };

  function cropSrcToBase(url){
    return new Promise((resolve, reject)=>{
      const im = new Image();
      im.onload = function(){
        const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.naturalWidth * k));
        c.height = Math.max(1, Math.round(im.naturalHeight * k));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        resolve(c);
      };
      im.onerror = reject;
      im.src = url;
    });
  }
  function cropScale(){ return Math.max(crop.fw / crop.base.width, crop.fh / crop.base.height) * crop.zoom; }
  function cropClamp(){
    const sc = cropScale();
    const mx = Math.max(0, (crop.base.width * sc - crop.fw) / 2);
    const my = Math.max(0, (crop.base.height * sc - crop.fh) / 2);
    crop.ox = Math.min(mx, Math.max(-mx, crop.ox));
    crop.oy = Math.min(my, Math.max(-my, crop.oy));
  }
  function cropFrameSize(){
    const r = crop.ratio === 'orig' ? crop.base.width / crop.base.height : Number(crop.ratio);
    if(r >= 1){ crop.fw = crop.box; crop.fh = Math.round(crop.box / r); }
    else { crop.fh = crop.box; crop.fw = Math.round(crop.box * r); }
    cropCanvas.style.width = crop.fw + 'px'; cropCanvas.style.height = crop.fh + 'px';
    cropCanvas.width = crop.fw * 2; cropCanvas.height = crop.fh * 2;
  }
  function cropDraw(){
    cropClamp();
    const sc = cropScale(), iw = crop.base.width * sc, ih = crop.base.height * sc;
    cropCtx.setTransform(2, 0, 0, 2, 0, 0);
    cropCtx.fillStyle = '#fff'; cropCtx.fillRect(0, 0, crop.fw, crop.fh);
    cropCtx.drawImage(crop.base, crop.fw / 2 + crop.ox - iw / 2, crop.fh / 2 + crop.oy - ih / 2, iw, ih);
  }
  function cropExport(){
    const k = CROP_OUT / Math.max(crop.fw, crop.fh);
    const out = document.createElement('canvas');
    out.width = Math.round(crop.fw * k); out.height = Math.round(crop.fh * k);
    const x = out.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, out.width, out.height);
    const sc = cropScale() * k, iw = crop.base.width * sc, ih = crop.base.height * sc;
    x.drawImage(crop.base, out.width / 2 + crop.ox * k - iw / 2, out.height / 2 + crop.oy * k - ih / 2, iw, ih);
    return out.toDataURL('image/jpeg', 0.85);
  }
  async function openCropper(url){
    try{ crop.base = await cropSrcToBase(url); }
    catch(err){ showToast('No se pudo abrir la imagen.'); return; }
    crop.box = Math.max(200, Math.min(300, window.innerWidth - 110));
    crop.zoom = 1; crop.ox = 0; crop.oy = 0; cropZoom.value = 1;
    document.querySelectorAll('#cropRatios button').forEach(b=> b.classList.toggle('active', b.dataset.r === crop.ratio));
    cropFrameSize(); cropDraw();
    cropOverlay.classList.add('active');
  }
  document.querySelectorAll('#cropRatios button').forEach(b=> b.addEventListener('click', ()=>{
    crop.ratio = b.dataset.r;
    document.querySelectorAll('#cropRatios button').forEach(x=> x.classList.toggle('active', x === b));
    crop.ox = 0; crop.oy = 0; cropFrameSize(); cropDraw();
  }));
  cropZoom.addEventListener('input', ()=>{ crop.zoom = Number(cropZoom.value); cropDraw(); });
  cropCanvas.addEventListener('wheel', e=>{
    e.preventDefault();
    crop.zoom = Math.min(4, Math.max(1, crop.zoom + (e.deltaY < 0 ? 0.1 : -0.1)));
    cropZoom.value = crop.zoom; cropDraw();
  }, { passive:false });
  cropCanvas.addEventListener('pointerdown', e=>{
    cropCanvas.setPointerCapture(e.pointerId);
    crop.drag = { x:e.clientX, y:e.clientY, ox:crop.ox, oy:crop.oy };
  });
  cropCanvas.addEventListener('pointermove', e=>{
    if(!crop.drag) return;
    crop.ox = crop.drag.ox + (e.clientX - crop.drag.x);
    crop.oy = crop.drag.oy + (e.clientY - crop.drag.y);
    cropDraw();
  });
  ['pointerup','pointercancel'].forEach(ev=> cropCanvas.addEventListener(ev, ()=>{ crop.drag = null; }));
  document.getElementById('cropRotate').addEventListener('click', ()=>{
    const b = crop.base, c = document.createElement('canvas');
    c.width = b.height; c.height = b.width;
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2); x.rotate(Math.PI / 2);
    x.drawImage(b, -b.width / 2, -b.height / 2);
    crop.base = c; crop.ox = 0; crop.oy = 0;
    cropFrameSize(); cropDraw();
  });
  document.getElementById('cropCancel').addEventListener('click', ()=> cropOverlay.classList.remove('active'));
  document.getElementById('cropOk').addEventListener('click', ()=>{
    currentPhotoData = cropExport();
    photoPreview.innerHTML = '<img src="'+currentPhotoData+'" alt="preview">';
    document.getElementById('btnRecrop').style.display = '';
    cropOverlay.classList.remove('active');
  });
  document.getElementById('btnRecrop').addEventListener('click', ()=>{ if(currentPhotoData) openCropper(currentPhotoData); });

  document.getElementById('prodPhoto').addEventListener('change', function(e){
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ev => openCropper(ev.target.result);
    reader.onerror = ()=> showToast('No se pudo leer la imagen.');
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  function calcCostoUSD(mxn, tasa, exportCost){
    mxn = Number(mxn)||0; tasa = Number(tasa)||1; exportCost = Number(exportCost)||0;
    if(tasa <= 0) tasa = 1;
    return (mxn * 1.05 / tasa) + exportCost;
  }

  function refreshProductCalc(){
    const mxn = document.getElementById('prodMXN').value;
    const tasa = document.getElementById('prodTasa').value;
    const exp = document.getElementById('prodExport').value;
    const venta = document.getElementById('prodVenta').value;
    const costo = calcCostoUSD(mxn, tasa, exp);
    document.getElementById('calcCostoUSD').textContent = fmtUSD(costo);
    const margen = (Number(venta)||0) - costo;
    const margenEl = document.getElementById('calcMargen');
    margenEl.textContent = fmtUSD(margen);
    margenEl.style.color = margen < 0 ? 'var(--danger)' : 'var(--wine)';
  }
  ['prodMXN','prodTasa','prodExport','prodVenta'].forEach(id=>{
    document.getElementById(id).addEventListener('input', refreshProductCalc);
  });

  const productForm = document.getElementById('productForm');
  const prodCancelBtn = document.getElementById('prodCancelEdit');

  function resetProductForm(){
    productForm.reset();
    document.getElementById('prodId').value = '';
    document.getElementById('prodPersonal').checked = false;
    document.getElementById('prodTasa').value = '18.00';
    document.getElementById('prodExport').value = '5.00';
    currentPhotoData = '';
    photoPreview.innerHTML = '&#128247;';
    document.getElementById('btnRecrop').style.display = 'none';
    document.getElementById('prodFormTitle').textContent = 'Nueva cartera';
    document.getElementById('prodSubmitBtn').textContent = 'Guardar producto';
    prodCancelBtn.style.display = 'none';
    refreshProductCalc();
  }
  prodCancelBtn.addEventListener('click', resetProductForm);

  productForm.addEventListener('submit', async function(e){
    e.preventDefault();
    const id = document.getElementById('prodId').value;
    const mxn = Number(document.getElementById('prodMXN').value);
    const tasa = Number(document.getElementById('prodTasa').value);
    const exp = Number(document.getElementById('prodExport').value);
    const venta = Number(document.getElementById('prodVenta').value);
    const existing = id ? products.find(p=>p.id === id) : null;
    // Si no cambiaste precio MXN, tasa ni exportación, se conserva el costo real que viene de tus importaciones
    const sameBase = existing && Math.abs(existing.precioMXN - mxn) < 0.0001 && Math.abs(existing.tasa - tasa) < 0.0001 && Math.abs(existing.exportCost - exp) < 0.0001;
    const costoUSD = sameBase ? existing.costoUSD : calcCostoUSD(mxn, tasa, exp);
    const photo = currentPhotoData || (existing ? existing.photo : '');

    const product = {
      id: id || null, photo,
      name: document.getElementById('prodName').value.trim(),
      desc: document.getElementById('prodDesc').value.trim(),
      precioMXN: mxn, tasa, exportCost: exp, costoUSD, ventaUSD: venta,
      stock: Number(document.getElementById('prodStock').value),
      personal: document.getElementById('prodPersonal').checked
    };

    let error;
    if(existing){
      ({ error } = await sb.from('products').update(productToRow(product)).eq('id', existing.id));
    } else {
      ({ error } = await sb.from('products').insert(productToRow(product)));
    }
    if(error){ console.error(error); showToast('No se pudo guardar el producto.'); return; }

    showToast(existing ? 'Producto actualizado.' : 'Producto agregado al inventario.');
    await refreshAllData();
    resetProductForm();
    renderAll();
  });

  function editProduct(id){
    const p = products.find(x=>x.id === id);
    if(!p) return;
    document.getElementById('prodId').value = p.id;
    document.getElementById('prodName').value = p.name;
    document.getElementById('prodDesc').value = p.desc || '';
    document.getElementById('prodMXN').value = p.precioMXN;
    document.getElementById('prodTasa').value = p.tasa;
    document.getElementById('prodExport').value = p.exportCost;
    document.getElementById('prodVenta').value = p.ventaUSD;
    document.getElementById('prodStock').value = p.stock;
    document.getElementById('prodPersonal').checked = !!p.personal;
    currentPhotoData = p.photo || '';
    photoPreview.innerHTML = p.photo ? '<img src="'+p.photo+'" alt="preview">' : '&#128247;';
    document.getElementById('btnRecrop').style.display = p.photo ? '' : 'none';
    document.getElementById('prodFormTitle').textContent = 'Editar cartera';
    document.getElementById('prodSubmitBtn').textContent = 'Actualizar producto';
    prodCancelBtn.style.display = 'inline-flex';
    refreshProductCalc();
    document.getElementById('view-inventario').scrollIntoView({behavior:'smooth'});
  }

  async function deleteProduct(id){
    if(!confirm('¿Eliminar este producto del inventario?')) return;
    const { error } = await sb.from('products').delete().eq('id', id);
    if(error){ console.error(error); showToast('No se pudo eliminar (puede tener ventas o importaciones asociadas).'); return; }
    await refreshAllData();
    renderAll();
    showToast('Producto eliminado.');
  }

  let inventorySearchTerm = '';
  let inventoryStockFilter = 'all';

  function renderInventory(){
    const tbody = document.querySelector('#tblInventario tbody');
    tbody.innerHTML = '';
    const term = inventorySearchTerm.trim().toLowerCase();
    const fSel = document.getElementById('inventoryFilter');
    const nDisp = products.filter(p=>!p.personal && p.stock > 0).length, nAgot = products.filter(p=>!p.personal && p.stock <= 0).length;
    fSel.innerHTML = '<option value="all">Todos ('+products.length+')</option><option value="disp">Disponibles ('+nDisp+')</option><option value="agot">Agotados ('+nAgot+')</option>';
    fSel.value = inventoryStockFilter;
    const visibleProducts = products.filter(p =>
      (!term || String(p.name || '').toLowerCase().includes(term)) &&
      (inventoryStockFilter === 'all' || (!p.personal && (inventoryStockFilter === 'disp' ? p.stock > 0 : p.stock <= 0)))
    ).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity:'base', numeric:true }));
    document.getElementById('emptyInventario').style.display = visibleProducts.length ? 'none' : 'block';
    document.getElementById('emptyInventario').textContent = products.length
      ? 'No se encontraron carteras con esa búsqueda.'
      : 'Aún no hay carteras registradas. Agrega la primera arriba.';
    visibleProducts.forEach(p=>{
      const margen = p.ventaUSD - p.costoUSD;
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td data-label="Foto">' + (p.photo ? '<img class="prod-thumb" src="'+p.photo+'">' : '<div class="prod-thumb placeholder">&#128092;</div>') + '</td>' +
        '<td data-label="Producto"><strong>'+escapeHtml(p.name)+'</strong>'+(p.personal?' <span class="tag-personal">Uso personal</span>':'')+'</td>' +
        '<td data-label="Costo MXN">'+fmtMXN(p.precioMXN)+'</td>' +
        '<td data-label="Costo total USD">'+fmtUSD(p.costoUSD)+'</td>' +
        '<td data-label="Precio venta USD">'+fmtUSD(p.ventaUSD)+'</td>' +
        '<td data-label="Margen">'+(p.personal?'<span style="color:var(--muted,#888)">—</span>':'<span class="'+(margen>=0?'pos':'neg')+'">'+fmtUSD(margen)+'</span>')+'</td>' +
        '<td data-label="Stock">'+p.stock+'</td>' +
        '<td data-label=""><div class="row-actions"><button class="link-btn" data-edit="'+p.id+'">Editar</button><button class="link-btn" data-personal="'+p.id+'">'+(p.personal?'Quitar uso personal':'Uso personal')+'</button><button class="link-btn danger" data-del="'+p.id+'">Eliminar</button></div></td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-edit]').forEach(b=> b.addEventListener('click', ()=>editProduct(b.dataset.edit)));
    tbody.querySelectorAll('[data-del]').forEach(b=> b.addEventListener('click', ()=>deleteProduct(b.dataset.del)));
    tbody.querySelectorAll('[data-personal]').forEach(b=> b.addEventListener('click', ()=>togglePersonal(b.dataset.personal)));
  }

  async function togglePersonal(id){
    const p = products.find(x=>x.id === id);
    if(!p) return;
    const { error } = await sb.from('products').update({ personal_use: !p.personal }).eq('id', id);
    if(error){ console.error(error); showToast('No se pudo actualizar el producto.'); return; }
    await refreshAllData();
    renderAll();
    showToast(p.personal ? 'Ya no es de uso personal.' : 'Marcado como uso personal.');
  }

  document.getElementById('inventoryFilter').addEventListener('change', function(){ inventoryStockFilter = this.value; renderInventory(); });
  const inventorySearch = document.getElementById('inventorySearch');
  if(inventorySearch){
    inventorySearch.addEventListener('input', function(){
      inventorySearchTerm = this.value;
      renderInventory();
    });
  }

  /* ===================== SALES ===================== */
  const saleForm = document.getElementById('saleForm');
  let saleLines = [{ pid:'', qty:1, price:'' }];
  const lineProduct = l => products.find(x=>x.id === l.pid);
  const linePrice = l => { const p = lineProduct(l); return (l.price !== '' && !isNaN(Number(l.price))) ? Number(l.price) : (p ? p.ventaUSD : 0); };
  function saleListTotal(){ return saleLines.reduce((a,l)=> a + (lineProduct(l) ? linePrice(l) * (Number(l.qty)||0) : 0), 0); }
  // Monto final realmente cobrado (opcional): si lo escribes, la venta se registra por ese valor
  function saleFinalAmount(){ const v = Number(document.getElementById('saleFinal').value); return v > 0 ? Math.round(v*100)/100 : 0; }
  function saleTotalNow(){ return saleFinalAmount() || saleListTotal(); }
  // repartir el monto final entre las líneas (proporcional al precio) para que el total y el margen sean reales
  function adjustedPrices(){
    const list = saleListTotal(), fin = saleFinalAmount();
    const prices = saleLines.map(l=>linePrice(l));
    if(!fin || Math.abs(fin - list) < 0.005 || list <= 0) return prices;
    const out = []; let acc = 0;
    saleLines.forEach((l,i)=>{
      const q = Number(l.qty)||1;
      if(i === saleLines.length-1){ out.push(Math.round((fin-acc)/q*1e6)/1e6); }
      else { const lt = Math.round(prices[i]*q*fin/list*100)/100; acc += lt; out.push(Math.round(lt/q*1e6)/1e6); }
    });
    return out;
  }

  function stockNote(l, p){
    if(p.stock <= 0) return '<b class="neg">⛔ Stock 0 — AGOTADO: no se puede despachar</b>';
    if((Number(l.qty)||0) > p.stock) return '<b class="neg">Solo hay '+p.stock+' en stock</b>';
    return 'Stock: '+p.stock;
  }
  function saleBlocked(){
    const need = {};
    saleLines.forEach(l=>{ const p = lineProduct(l); if(p) need[p.id] = (need[p.id]||0) + (Number(l.qty)||0); });
    return Object.keys(need).some(id=>{ const p = products.find(x=>x.id === id); return p.stock <= 0 || need[id] > p.stock; });
  }
  function updateSaleBlock(){
    const btn = document.querySelector('#saleForm button[type=submit]');
    if(!btn) return;
    const bl = saleBlocked();
    btn.disabled = bl; btn.style.opacity = bl ? '.5' : ''; btn.title = bl ? 'Hay productos sin stock suficiente' : '';
  }
  function renderSaleLines(){
    const tb = document.querySelector('#saleLinesTbl tbody');
    saleLines = saleLines.filter((l,i)=> true);
    document.getElementById('saleProductList').innerHTML = products.filter(x=>!x.personal)
      .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''), 'es', { sensitivity:'base', numeric:true }))
      .map(x=>'<option value="'+escapeHtml(x.name)+'" label="'+(x.stock <= 0 ? '⛔ AGOTADO (Stock 0)' : 'Stock: '+x.stock)+'"></option>').join('');
    tb.innerHTML = saleLines.map((l,i)=>{
      const p = lineProduct(l);
      return '<tr data-i="'+i+'"><td><input data-k="pname" list="saleProductList" type="text" autocomplete="off" required placeholder="Escribe para buscar el producto" value="'+escapeHtml(p ? p.name : (l.text || ''))+'" style="min-width:230px">'+
        '<br><small data-note>'+(p ? stockNote(l, p) : '')+'</small></td>'+
        '<td><input data-k="qty" type="number" min="1" step="1" value="'+l.qty+'" style="width:70px" required></td>'+
        '<td><input data-k="price" type="number" min="0" step="0.01" value="'+(l.price === '' ? (p ? p.ventaUSD : '') : l.price)+'" placeholder="Catálogo" style="width:110px"></td>'+
        '<td data-sub>'+fmtUSD(p ? linePrice(l) * (Number(l.qty)||0) : 0)+'</td>'+
        '<td>'+(saleLines.length > 1 ? '<button type="button" class="link-btn danger" data-rmline="'+i+'">Quitar</button>' : '')+'</td></tr>';
    }).join('');
    refreshSaleCalc(true);
  }
  function renderSaleProductOptions(){ renderSaleLines(); }

  const saleLinesTbl = document.getElementById('saleLinesTbl');
  saleLinesTbl.addEventListener('input', e=>{
    const k = e.target.dataset.k, tr = e.target.closest('tr');
    if(!k || !tr) return;
    const l = saleLines[Number(tr.dataset.i)];
    if(k === 'pname'){ l.text = e.target.value; return; }
    l[k] = e.target.value;
    const p = lineProduct(l);
    tr.querySelector('[data-sub]').textContent = fmtUSD(p ? linePrice(l) * (Number(l.qty)||0) : 0);
    const note = tr.querySelector('[data-note]'); if(note) note.innerHTML = p ? stockNote(l, p) : '';
    refreshSaleCalc(true);
  });
  saleLinesTbl.addEventListener('change', e=>{
    if(e.target.dataset.k !== 'pname') return;
    const l = saleLines[Number(e.target.closest('tr').dataset.i)];
    const q = normText(e.target.value);
    let found = q ? products.filter(x=>!x.personal && normText(x.name) === q) : [];
    if(!found.length && q) found = products.filter(x=>!x.personal && normText(x.name).includes(q));
    if(found.length > 1){ const inStock = found.filter(x=>x.stock > 0); if(inStock.length === 1) found = inStock; }
    if(found.length === 1){ l.pid = found[0].id; l.text = ''; }
    else {
      l.pid = ''; l.text = e.target.value;
      if(q) showToast(found.length > 1 ? 'Hay varios productos con ese texto: escribe más del nombre o elígelo de la lista.' : 'No encontré ese producto: elígelo de la lista.');
    }
    l.price = '';
    if(found.length === 1 && found[0].stock <= 0) showToast('⛔ '+found[0].name+' está AGOTADO (stock 0). No se puede vender.');
    customRows = []; renderCustomRows(); renderSaleLines(); refreshSaleCalc();
  });
  saleLinesTbl.addEventListener('click', e=>{
    if(e.target.dataset.rmline === undefined) return;
    saleLines.splice(Number(e.target.dataset.rmline), 1);
    if(!saleLines.length) saleLines = [{ pid:'', qty:1, price:'' }];
    renderSaleLines(); refreshSaleCalc(true);
  });
  document.getElementById('saleAddLine').addEventListener('click', ()=>{ saleLines.push({ pid:'', qty:1, price:'' }); renderSaleLines(); });

  let customRows = [];
  function renderCustomRows(){
    const box = document.getElementById('saleCustomRows');
    box.innerHTML = '';
    customRows.forEach((r,i)=>{
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;';
      row.innerHTML =
        '<input type="number" min="0" step="0.01" value="'+r.amount+'" placeholder="Monto USD" data-cr="amount" style="width:130px;">' +
        '<input type="date" value="'+r.due+'" data-cr="due" style="width:160px;">' +
        '<label style="display:flex;gap:4px;align-items:center;font-size:13px;margin:0;"><input type="checkbox" data-cr="paid" '+(r.paid?'checked':'')+' style="width:auto;"> Cobrado</label>' +
        '<button type="button" class="link-btn danger" data-crdel="'+i+'">Quitar</button>';
      row.querySelectorAll('[data-cr]').forEach(inp=> inp.addEventListener('input', ()=>{
        const k = inp.dataset.cr;
        r[k] = k==='paid' ? inp.checked : inp.value;
        refreshSaleCalc(true);
      }));
      row.querySelector('[data-crdel]').addEventListener('click', ()=>{ customRows.splice(i,1); renderCustomRows(); refreshSaleCalc(true); });
      box.appendChild(row);
    });
  }
  function addCustomRow(){
    const total = saleTotalNow();
    const used = customRows.reduce((a,r)=>a+(Number(r.amount)||0),0);
    const left = Math.max(0, Math.round((total-used)*100)/100);
    customRows.push({ amount: left || '', due: document.getElementById('saleDate').value || todayLocal(), paid: customRows.length === 0 });
    renderCustomRows();
    refreshSaleCalc(true);
  }

  function refreshSaleCalc(keepRows){
    const total = saleTotalNow();
    document.getElementById('calcSaleTotal').textContent = fmtUSD(total);
    updateSaleBlock();
    const adjEl = document.getElementById('calcSaleAdj'), listT = saleListTotal();
    if(saleFinalAmount() && Math.abs(saleFinalAmount() - listT) >= 0.005){
      const dd = Math.round((listT - saleFinalAmount())*100)/100;
      adjEl.style.display = ''; adjEl.innerHTML = 'Según precios: <b>'+fmtUSD(listT)+'</b> · '+(dd > 0 ? 'Descuento' : 'Cargo extra')+': <b>'+fmtUSD(Math.abs(dd))+'</b>';
    } else { adjEl.style.display = 'none'; }
    const cost = saleLines.reduce((a,l)=>{ const p = lineProduct(l); return a + (p ? p.costoUSD * (Number(l.qty)||0) : 0); }, 0);
    const profit = total - cost;
    const margin = total > 0 ? (profit/total*100) : 0;
    document.getElementById('calcSaleCost').textContent = fmtUSD(cost);
    const pe = document.getElementById('calcSaleProfit');
    pe.textContent = fmtUSD(profit); pe.style.color = profit < 0 ? 'var(--danger)' : 'var(--good)';
    const me2 = document.getElementById('calcSaleMargin');
    me2.textContent = margin.toFixed(1) + '%'; me2.style.color = profit < 0 ? 'var(--danger)' : 'var(--good)';
    const type = salePayType.value;
    const cuotas = type === 'cuotas';
    const custom = type === 'personalizado';
    document.getElementById('saleAbonoField').style.display = cuotas ? '' : 'none';
    document.getElementById('saleCustomField').style.display = custom ? '' : 'none';
    if(custom && !customRows.length && keepRows !== true){ addCustomRow(); }

    const plan = document.getElementById('calcSalePlan');
    const abono = Number(saleAbono.value) || 0;
    if(cuotas && total > 0 && abono > 0 && abono < total){
      const rest = total - abono, c1 = Math.round(rest/2*100)/100, c2 = Math.round((rest-c1)*100)/100;
      const d = document.getElementById('saleDate').value || todayLocal();
      plan.style.display = '';
      plan.innerHTML = 'Abono hoy <b>'+fmtUSD(abono)+'</b> · Cuota 1 <b>'+fmtUSD(c1)+'</b> ('+addDays(d,15)+') · Cuota 2 <b>'+fmtUSD(c2)+'</b> ('+addDays(d,30)+')';
    } else { plan.style.display = 'none'; }

    if(custom){
      const sum = customRows.reduce((a,r)=>a+(Number(r.amount)||0),0);
      const diff = Math.round((total-sum)*100)/100;
      const el = document.getElementById('saleCustomSum');
      el.innerHTML = 'Suman <b>'+fmtUSD(sum)+'</b> de <b>'+fmtUSD(total)+'</b> · ' +
        (Math.abs(diff) <= 0.01 ? '<span class="pos">Completo</span>' :
         (diff > 0 ? '<span class="neg">Faltan '+fmtUSD(diff)+'</span>' : '<span class="neg">Sobran '+fmtUSD(-diff)+'</span>'));
    }
  }
  function addDays(iso, n){
    const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  const salePayType = document.getElementById('salePayType');
  const saleAbono = document.getElementById('saleAbono');
  salePayType.addEventListener('change', ()=> refreshSaleCalc());
  document.getElementById('saleFinal').addEventListener('input', ()=> refreshSaleCalc(true));
  saleAbono.addEventListener('input', ()=>refreshSaleCalc());
  document.getElementById('saleAddPay').addEventListener('click', addCustomRow);
  document.getElementById('saleDate').addEventListener('change', ()=>refreshSaleCalc(true));

  saleForm.addEventListener('submit', async function(e){
    e.preventDefault();
    if(saleLines.some(l=>!lineProduct(l))){ showToast('Selecciona un producto en cada línea.'); return; }
    if(saleLines.some(l=>!(Number(l.qty) >= 1))){ showToast('La cantidad debe ser al menos 1.'); return; }
    const need = {};
    saleLines.forEach(l=>{ need[l.pid] = (need[l.pid]||0) + Number(l.qty); });
    for(const pid of Object.keys(need)){
      const p = products.find(x=>x.id === pid);
      if(need[pid] > p.stock){ showToast('No hay suficiente stock de '+p.name+' (disponible: '+p.stock+').'); return; }
    }
    if(saleLines.some(l=>!(linePrice(l) >= 0))){ showToast('El precio unitario no es válido.'); return; }
    const total = saleTotalNow();
    let schedule = null;
    if(salePayType.value === 'personalizado'){
      if(!customRows.length){ showToast('Agrega al menos un pago.'); return; }
      const sum = customRows.reduce((a,r)=>a+(Number(r.amount)||0),0);
      if(customRows.some(r=>!(Number(r.amount)>0))){ showToast('Cada pago debe ser mayor que 0.'); return; }
      if(Math.abs(sum-total) > 0.01){ showToast('Los pagos suman '+fmtUSD(sum)+' y el total es '+fmtUSD(total)+'.'); return; }
      schedule = customRows.map(r=>({ amount: Number(r.amount), due: r.due || todayLocal(), paid: !!r.paid }));
    }
    const adj = adjustedPrices();
    const items = saleLines.map((l,i)=>{ const p = lineProduct(l), u = adj[i];
      return { product:p.id, qty:Number(l.qty), unit_price: Math.abs(u - p.ventaUSD) > 0.0001 ? u : null }; });

    const { error: saleErr } = await sb.rpc('register_sale_order', {
      p_items: items, p_schedule: schedule,
      p_client: document.getElementById('saleClient').value.trim(),
      p_date: document.getElementById('saleDate').value || todayLocal(),
      p_phone: document.getElementById('salePhone').value.trim(),
      p_advisor: document.getElementById('saleAdvisor').value.trim(),
      p_payment_type: salePayType.value,
      p_abono: salePayType.value === 'cuotas' ? Number(saleAbono.value) : null
    });
    if(saleErr){ console.error(saleErr); showToast(saleErr.message || 'No se pudo registrar la venta.'); return; }

    await refreshAllData();
    saleForm.reset();
    customRows = []; renderCustomRows();
    saleLines = [{ pid:'', qty:1, price:'' }];
    document.getElementById('saleDate').value = todayLocal();
    document.getElementById('saleAdvisor').value = (me && me.full_name) || '';
    renderAll();
    showToast(items.length > 1 ? 'Venta registrada ('+items.length+' productos).' : 'Venta registrada.');
  });

  async function deleteSale(ids){
    const list = String(ids).split(',');
    if(!confirm(list.length > 1 ? '¿Eliminar esta venta completa ('+list.length+' productos)? El stock de cada producto se restituirá.' : '¿Eliminar esta venta? El stock del producto se restituirá.')) return;
    for(const id of list){
      const { error } = await sb.rpc('delete_sale', { p_sale: id });
      if(error){ console.error(error); showToast(error.message || 'No se pudo eliminar la venta.'); await refreshAllData(); renderAll(); return; }
    }
    await refreshAllData();
    renderAll();
    showToast('Venta eliminada.');
  }

  function renderSales(){
    const tbody = document.querySelector('#tblVentas tbody');
    tbody.innerHTML = '';
    const mSel = document.getElementById('salesMonth');
    const allMonths = [...new Set(sales.map(s=>String(s.date).slice(0,7)))].sort().reverse();
    const prevM = mSel.value;
    mSel.innerHTML = '<option value="all">Todos los meses</option>' + allMonths.map(m=>'<option value="'+m+'">'+monthLabel(m)+'</option>').join('');
    mSel.value = (prevM === 'all' || allMonths.includes(prevM)) ? prevM : 'all';
    const all = sales;
    const vis = mSel.value === 'all' ? all : all.filter(s=>String(s.date).slice(0,7) === mSel.value);
    document.getElementById('emptyVentas').style.display = vis.length ? 'none' : 'block';
    document.getElementById('emptyVentas').textContent = all.length ? 'No hay ventas en este mes.' : 'Aún no hay ventas registradas.';
    const tv = vis.reduce((a,x)=>a+x.totalUSD,0), tp = vis.reduce((a,x)=>a+x.profitUSD,0);
    document.getElementById('salesSummary').innerHTML = vis.length ?
      'Vendido <b>'+fmtUSD(tv)+'</b> · Ganancia <b class="'+(tp>=0?'pos':'neg')+'">'+fmtUSD(tp)+'</b> · Margen <b>'+(tv>0?(tp/tv*100).toFixed(1):'0.0')+'%</b>' : '';
    // una fila por venta: las líneas con el mismo order_id se agrupan
    const groups = [], byOrder = {};
    vis.forEach(s=>{
      if(!s.orderId){ groups.push([s]); return; }
      if(!byOrder[s.orderId]){ byOrder[s.orderId] = []; groups.push(byOrder[s.orderId]); }
      byOrder[s.orderId].push(s);
    });
    groups.forEach(g=>{
      const s = g[0];
      const totalUSD = g.reduce((a,x)=>a+x.totalUSD,0), profitUSD = g.reduce((a,x)=>a+x.profitUSD,0), qty = g.reduce((a,x)=>a+x.qty,0);
      const pays = salePayments.filter(x=>g.some(y=>y.id === x.saleId)).sort((a,b)=>a.number-b.number);
      const paid = pays.filter(x=>x.paid).reduce((a,x)=>a+x.amount, 0);
      const next = pays.find(x=>!x.paid);
      const lastN = pays.length ? Math.max(...pays.map(x=>x.number)) : 0;
      const stepLbl = next ? (next.number === 0 ? 'el abono' : 'el pago '+next.number+' de '+lastN+(next.number === lastN ? ' (último)' : '')) : '';
      const payHtml = !next ? '<span class="pos">&#10003; Pagado completo</span>' :
        '<b class="neg">Falta cobrar '+stepLbl+'</b><br>Saldo '+fmtUSD(totalUSD - paid)+'<br><small>'+fmtUSD(next.amount)+' · vence '+next.due+
        (next.due < todayLocal() ? ' <b class="neg">(vencida)</b>' : '')+'</small> <button class="link-btn" data-pay="'+next.id+'">Cobrar</button>';
      const prodHtml = g.length === 1 ? escapeHtml(s.productName) :
        g.map(x=>x.qty+' × '+escapeHtml(x.productName)).join('<br>');
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td data-label="Fecha">'+s.date+'</td>' +
        '<td data-label="Producto">'+prodHtml+'</td>' +
        '<td data-label="Cliente">'+escapeHtml(s.client)+
          (s.phone ? '<br><small>'+escapeHtml(s.phone)+'</small>' : '')+
          (s.advisor ? '<br><small>Asesor: '+escapeHtml(s.advisor)+'</small>' : '')+'</td>' +
        '<td data-label="Cant.">'+qty+'</td>' +
        '<td data-label="Total USD">'+fmtUSD(totalUSD)+'</td>' +
        '<td data-label="Ganancia USD"><span class="'+(profitUSD>=0?'pos':'neg')+'">'+fmtUSD(profitUSD)+'</span></td>' +
        '<td data-label="Margen"><span class="'+(profitUSD>=0?'pos':'neg')+'">'+(totalUSD>0?(profitUSD/totalUSD*100).toFixed(1):'0.0')+'%</span></td>' +
        '<td data-label="Pago">'+payHtml+'</td>' +
        '<td data-label=""><div class="row-actions"><button class="link-btn" data-editsale="'+g.map(x=>x.id).join(',')+'">Editar</button><button class="link-btn danger" data-delsale="'+g.map(x=>x.id).join(',')+'">Eliminar</button></div></td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-delsale]').forEach(b=> b.addEventListener('click', ()=>deleteSale(b.dataset.delsale)));
    tbody.querySelectorAll('[data-editsale]').forEach(b=> b.addEventListener('click', ()=>openEditSale(b.dataset.editsale)));
    tbody.querySelectorAll('[data-pay]').forEach(b=> b.addEventListener('click', async ()=>{
      if(!confirm('¿Registrar este pago como cobrado hoy?')) return;
      const { error } = await sb.rpc('mark_payment', { p_payment: b.dataset.pay, p_paid: true, p_paid_date: todayLocal() });
      if(error){ console.error(error); showToast(error.message || 'No se pudo registrar el pago.'); return; }
      await refreshAllData(); renderAll(); showToast('Pago registrado.');
    }));
  }

  /* ===================== VENTAS POR ASESOR ===================== */
  const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const monthLabel = ym => MESES[Number(ym.slice(5,7))-1] + ' ' + ym.slice(0,4);
  function advStats(list){
    const orders = {};
    list.forEach(s=>{
      const key = s.orderId || s.id;
      const o = orders[key] || (orders[key] = { adv:(s.advisor||'').trim() || 'Sin asesor', total:0, profit:0 });
      o.total += s.totalUSD; o.profit += s.profitUSD;
    });
    const by = {};
    Object.values(orders).forEach(o=>{
      const a = by[o.adv] || (by[o.adv] = { name:o.adv, total:0, profit:0, n:0 });
      a.total += o.total; a.profit += o.profit; a.n += 1;
    });
    return Object.values(by);
  }
  function renderAdvisorChart(){
    const sel = document.getElementById('advMonth'), metricSel = document.getElementById('advMetric');
    if(!sel) return;
    const months = [...new Set(sales.map(s=>String(s.date).slice(0,7)))].sort().reverse();
    const prev = sel.value;
    sel.innerHTML = '<option value="all">Todos los meses</option>' + months.map(m=>'<option value="'+m+'">'+monthLabel(m)+'</option>').join('');
    sel.value = months.includes(prev) || prev === 'all' ? prev : (months[0] || 'all');
    const metric = metricSel.value || 'total';
    const list = sel.value === 'all' ? sales : sales.filter(s=>String(s.date).slice(0,7) === sel.value);
    const stats = advStats(list).sort((a,b)=>b[metric]-a[metric]);
    const el = document.getElementById('advChart');
    if(!stats.length){ el.innerHTML = '<p class="empty">Aún no hay ventas en este periodo.</p>'; }
    else {
      const max = Math.max(...stats.map(x=>x[metric]), 0.0001);
      const fmt = v => metric === 'n' ? String(v) : fmtUSD(v);
      el.innerHTML = stats.map((x,i)=>
        '<div style="display:grid;grid-template-columns:minmax(90px,170px) 1fr auto;gap:10px;align-items:center;margin:6px 0;">'+
        '<div style="font-weight:'+(i===0?'700':'500')+'">'+(i===0?'&#128081; ':'')+escapeHtml(x.name)+'</div>'+
        '<div style="background:var(--cream-deep);height:22px;"><div style="height:100%;width:'+Math.max(2, Math.max(x[metric],0)/max*100)+'%;background:'+(i===0?'var(--wine)':'var(--gold)')+'"></div></div>'+
        '<div style="min-width:130px;text-align:right;"><b>'+fmt(x[metric])+'</b><br><small>'+x.n+' venta'+(x.n===1?'':'s')+'</small></div></div>').join('');
    }
    // líder de cada mes
    document.getElementById('advLeaders').innerHTML = months.length ? '<b>Líder por mes:</b> ' + months.map(m=>{
      const st = advStats(sales.filter(s=>String(s.date).slice(0,7) === m)).sort((a,b)=>b[metric]-a[metric])[0];
      return monthLabel(m)+': <b>'+escapeHtml(st.name)+'</b> ('+(metric === 'n' ? st.n : fmtUSD(st[metric]))+')';
    }).join(' · ') : '';
  }
  ['advMonth','advMetric'].forEach(id=>{ const e = document.getElementById(id); if(e) e.addEventListener('change', renderAdvisorChart); });

  /* ===================== PANEL DE COBROS PENDIENTES ===================== */
  function advOwedHtml(rows){
    const by = {};
    rows.forEach(r=>{ const a = (r.g[0].advisor || 'Sin asesor'); by[a] = (by[a]||0) + (r.total - r.paid); });
    const list = Object.keys(by).sort((a,b)=>by[b]-by[a]);
    if(!list.length) return '';
    return '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 16px;">'+list.map(a=>'<span>'+escapeHtml(a)+' <b>'+fmtUSD(by[a])+'</b></span>').join('')+'</div>';
  }
  function renderCobros(){
    const tbody = document.querySelector('#tblCobros tbody');
    if(!tbody) return;
    tbody.innerHTML = '';
    const today = todayLocal();
    const groups = [], byOrder = {};
    sales.forEach(s=>{
      if(!s.orderId){ groups.push([s]); return; }
      if(!byOrder[s.orderId]){ byOrder[s.orderId] = []; groups.push(byOrder[s.orderId]); }
      byOrder[s.orderId].push(s);
    });
    const rows = [];
    groups.forEach(g=>{
      const pays = salePayments.filter(x=>g.some(y=>y.id === x.saleId)).sort((a,b)=>a.number-b.number);
      const next = pays.find(x=>!x.paid);
      if(!next) return;
      const total = g.reduce((a,x)=>a+x.totalUSD,0);
      const paid = pays.filter(x=>x.paid).reduce((a,x)=>a+x.amount,0);
      rows.push({ g, pays, next, total, paid, kind: next.due < today ? 0 : (next.due === today ? 1 : (next.due <= addDays(today,3) ? 2 : 3)) });
    });
    rows.sort((a,b)=>a.kind-b.kind || (a.next.due < b.next.due ? -1 : 1));
    const owed = rows.reduce((a,r)=>a + (r.total - r.paid), 0);
    const late = rows.filter(r=>r.kind === 0).length;
    document.getElementById('cobrosSummary').innerHTML = rows.length ?
      '<b>'+rows.length+'</b> cliente'+(rows.length===1?'':'s')+' con saldo · Por cobrar <b>'+fmtUSD(owed)+'</b>' + (late ? ' · <b class="neg">'+late+' vencido'+(late===1?'':'s')+'</b>' : '') + advOwedHtml(rows) : '';
    document.getElementById('emptyCobros').style.display = rows.length ? 'none' : 'block';
    const ST = ['<b class="neg">VENCIDO</b>','<b style="color:var(--wine)">Vence HOY</b>','Vence pronto','Al día'];
    rows.forEach(r=>{
      const s = r.g[0], lastN = Math.max(...r.pays.map(x=>x.number));
      const chips = r.pays.map(p=>{
        const lbl = p.number === 0 ? 'Abono' : 'Pago '+p.number;
        return p.paid ? '<div><span class="pos">&#10003; '+lbl+'</span> '+fmtUSD(p.amount)+'</div>' :
          '<div>'+(p.id === r.next.id ? '<b>' : '')+lbl+' '+fmtUSD(p.amount)+' · '+p.due+(p.due < today ? ' <b class="neg">(vencido)</b>' : '')+(p.id === r.next.id ? '</b>' : '')+'</div>';
      }).join('');
      const nextLbl = r.next.number === 0 ? 'el abono' : 'el pago '+r.next.number+' de '+lastN;
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td data-label="Cliente"><strong>'+escapeHtml(s.client)+'</strong>'+(s.phone?'<br><small>'+escapeHtml(s.phone)+'</small>':'')+(s.advisor?'<br><small>Asesor: '+escapeHtml(s.advisor)+'</small>':'')+'</td>'+
        '<td data-label="Venta">'+s.date+'<br><small>'+r.g.map(x=>x.qty+' × '+escapeHtml(x.productName)).join('<br>')+'</small><br><b>'+fmtUSD(r.total)+'</b></td>'+
        '<td data-label="Cobrado / Saldo">Cobrado '+fmtUSD(r.paid)+'<br><b class="neg">Saldo '+fmtUSD(r.total-r.paid)+'</b></td>'+
        '<td data-label="Plan de pagos">'+chips+'</td>'+
        '<td data-label="Estado">'+ST[r.kind]+'<br><small>Falta '+nextLbl+'</small></td>'+
        '<td data-label=""><div class="row-actions"><button class="link-btn" data-cobrar="'+r.next.id+'">Cobrar '+(r.next.number === 0 ? 'abono' : 'pago '+r.next.number)+'</button>'+'</div></td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-cobrar]').forEach(b=> b.addEventListener('click', async ()=>{
      if(!confirm('¿Registrar este pago como cobrado hoy?')) return;
      const { error } = await sb.rpc('mark_payment', { p_payment: b.dataset.cobrar, p_paid: true, p_paid_date: todayLocal() });
      if(error){ console.error(error); showToast(error.message || 'No se pudo registrar el pago.'); return; }
      await refreshAllData(); renderAll(); showToast('Pago registrado.');
    }));
  }

  /* ===================== AVISO DE COBROS (cuotas a 15 y 30 días) ===================== */
  function renderPayBanner(){
    const box = document.getElementById('payBanner');
    if(!box) return;
    const today = todayLocal(), soon = addDays(today, 3);
    const items = salePayments.filter(p=>!p.paid && p.due <= soon).map(p=>{
      const sale = sales.find(x=>x.id === p.saleId);
      return { p, client: sale ? sale.client : '', kind: p.due < today ? 0 : (p.due === today ? 1 : 2) };
    }).sort((a,b)=>a.kind-b.kind || (a.p.due < b.p.due ? -1 : 1));
    const cb = document.getElementById('cobrosBadge');
    if(cb) cb.innerHTML = items.length ? '<span style="background:var(--danger);color:#fff;border-radius:999px;padding:1px 7px;font-size:11px;margin-left:4px;">'+items.length+'</span>' : '';
    if(!items.length){ box.style.display = 'none'; box.innerHTML = ''; return; }
    const LBL = ['<b class="neg">Vencida</b>','<b style="color:var(--wine)">Vence HOY</b>','Vence pronto'];
    box.innerHTML = '<b>&#128276; Cobros pendientes</b>' + items.map(it=>
      '<div style="margin-top:6px;">'+LBL[it.kind]+' · '+(it.p.number === 0 ? 'Abono' : 'Cuota '+it.p.number)+' · '+escapeHtml(it.client)+' · <b>'+fmtUSD(it.p.amount)+'</b> · '+it.p.due+
      ' <button class="link-btn" data-paybanner="'+it.p.id+'">Cobrar</button></div>').join('');
    box.style.display = '';
    box.querySelectorAll('[data-paybanner]').forEach(b=> b.addEventListener('click', async ()=>{
      if(!confirm('¿Registrar este pago como cobrado hoy?')) return;
      const { error } = await sb.rpc('mark_payment', { p_payment: b.dataset.paybanner, p_paid: true, p_paid_date: todayLocal() });
      if(error){ console.error(error); showToast(error.message || 'No se pudo registrar el pago.'); return; }
      await refreshAllData(); renderAll(); showToast('Pago registrado.');
    }));
  }

  document.getElementById('salesMonth').addEventListener('change', renderSales);

  /* ===================== EDITAR VENTA ===================== */
  let editSaleIds = [];
  function openEditSale(ids){
    editSaleIds = String(ids).split(',');
    const s = sales.find(x=>x.id === editSaleIds[0]);
    if(!s) return;
    document.getElementById('esClient').value = s.client || '';
    document.getElementById('esPhone').value = s.phone || '';
    document.getElementById('esAdvisor').value = s.advisor || '';
    document.getElementById('esDate').value = s.date;
    document.getElementById('editSaleOverlay').classList.add('active');
  }
  document.getElementById('esCancel').addEventListener('click', ()=> document.getElementById('editSaleOverlay').classList.remove('active'));
  document.getElementById('editSaleForm').addEventListener('submit', async function(e){
    e.preventDefault();
    const { error } = await sb.rpc('update_sale_info', {
      p_sales: editSaleIds,
      p_client: document.getElementById('esClient').value,
      p_phone: document.getElementById('esPhone').value,
      p_advisor: document.getElementById('esAdvisor').value,
      p_date: document.getElementById('esDate').value
    });
    if(error){ console.error(error); showToast(error.message || 'No se pudo guardar la venta.'); return; }
    document.getElementById('editSaleOverlay').classList.remove('active');
    await refreshAllData(); renderAll(); showToast('Venta actualizada.');
  });

  /* ===================== EXPENSES ===================== */
  const expenseForm = document.getElementById('expenseForm');
  expenseForm.addEventListener('submit', async function(e){
    e.preventDefault();
    const expense = { desc: document.getElementById('expDesc').value.trim(), date: document.getElementById('expDate').value, amountUSD: Number(document.getElementById('expAmount').value) };
    const { error } = await sb.from('expenses').insert(expenseToRow(expense));
    if(error){ console.error(error); showToast('No se pudo registrar el gasto.'); return; }
    await refreshAllData();
    expenseForm.reset();
    document.getElementById('expDate').value = todayLocal();
    renderAll();
    showToast('Gasto registrado.');
  });

  async function deleteExpense(id){
    if(!confirm('¿Eliminar este gasto?')) return;
    const { error } = await sb.from('expenses').delete().eq('id', id);
    if(error){ console.error(error); showToast('No se pudo eliminar el gasto.'); return; }
    await refreshAllData();
    renderAll();
    showToast('Gasto eliminado.');
  }

  function renderExpenses(){
    const tbody = document.querySelector('#tblGastos tbody');
    tbody.innerHTML = '';
    document.getElementById('emptyGastos').style.display = expenses.length ? 'none' : 'block';
    expenses.forEach(g=>{
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td data-label="Fecha">'+g.date+'</td>' +
        '<td data-label="Descripción">'+escapeHtml(g.desc)+'</td>' +
        '<td data-label="Monto USD">'+fmtUSD(g.amountUSD)+'</td>' +
        '<td data-label=""><button class="link-btn danger" data-delexp="'+g.id+'">Eliminar</button></td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-delexp]').forEach(b=> b.addEventListener('click', ()=>deleteExpense(b.dataset.delexp)));
  }

  /* ===================== DASHBOARD ===================== */
  function renderDashboard(){
    const ingresos = sales.reduce((sum,s)=> sum + s.totalUSD, 0);
    const cogs = sales.reduce((sum,s)=> sum + s.costoUnitario * s.qty, 0);
    const gastos = expenses.reduce((sum,g)=> sum + g.amountUSD, 0);
    const costos = cogs + gastos;
    const ganancia = ingresos - costos;
    const stockTotal = products.filter(p=>!p.personal).reduce((sum,p)=> sum + (Number(p.stock)||0), 0);

    document.getElementById('statIngresos').textContent = fmtUSD(ingresos);
    document.getElementById('statCostos').textContent = fmtUSD(costos);
    document.getElementById('statGanancia').textContent = fmtUSD(ganancia);
    document.getElementById('statStock').textContent = stockTotal;
    document.getElementById('cardGanancia').classList.toggle('neg', ganancia < 0);

    renderMonthly();
    const tbody = document.querySelector('#tblRecentSales tbody');
    tbody.innerHTML = '';
    const recent = sales.slice(0,5);
    document.getElementById('emptyRecentSales').style.display = recent.length ? 'none' : 'block';
    recent.forEach(s=>{
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td data-label="Fecha">'+s.date+'</td>' +
        '<td data-label="Producto">'+escapeHtml(s.productName)+'</td>' +
        '<td data-label="Cliente">'+escapeHtml(s.client)+'</td>' +
        '<td data-label="Cant.">'+s.qty+'</td>' +
        '<td data-label="Total">'+fmtUSD(s.totalUSD)+'</td>' +
        '<td data-label="Ganancia"><span class="'+(s.profitUSD>=0?'pos':'neg')+'">'+fmtUSD(s.profitUSD)+'</span></td>';
      tbody.appendChild(tr);
    });
  }

  function renderMonthly(){
    const tb = document.querySelector('#tblMonthly tbody');
    if(!tb) return;
    tb.innerHTML = '';
    const m = {};
    const get = ym => m[ym] || (m[ym] = { n:0, ing:0, cogs:0, gas:0, orders:new Set() });
    sales.forEach(x=>{ const r = get(String(x.date).slice(0,7)); r.ing += x.totalUSD; r.cogs += x.costoUnitario * x.qty; r.orders.add(x.orderId || x.id); });
    expenses.forEach(g=>{ get(String(g.date).slice(0,7)).gas += g.amountUSD; });
    const months = Object.keys(m).sort().reverse();
    document.getElementById('emptyMonthly').style.display = months.length ? 'none' : 'block';
    const tot = { n:0, ing:0, cogs:0, gas:0 };
    months.forEach(ym=>{
      const r = m[ym], bruta = r.ing - r.cogs, neta = bruta - r.gas, n = r.orders.size;
      tot.n += n; tot.ing += r.ing; tot.cogs += r.cogs; tot.gas += r.gas;
      const tr = document.createElement('tr');
      tr.innerHTML = '<td data-label="Mes"><strong>'+monthLabel(ym)+'</strong></td><td data-label="Ventas">'+n+'</td><td data-label="Ingresos">'+fmtUSD(r.ing)+'</td><td data-label="Costo vendido">'+fmtUSD(r.cogs)+'</td>'+
        '<td data-label="Ganancia bruta">'+fmtUSD(bruta)+'</td><td data-label="Gastos">'+fmtUSD(r.gas)+'</td>'+
        '<td data-label="Ganancia neta"><span class="'+(neta>=0?'pos':'neg')+'">'+fmtUSD(neta)+'</span></td>'+
        '<td data-label="Margen neto"><span class="'+(neta>=0?'pos':'neg')+'">'+(r.ing>0?(neta/r.ing*100).toFixed(1):'0.0')+'%</span></td>';
      tb.appendChild(tr);
    });
    if(months.length > 1){
      const bruta = tot.ing - tot.cogs, neta = bruta - tot.gas, tr = document.createElement('tr');
      tr.style.fontWeight = '700';
      tr.innerHTML = '<td>Total</td><td>'+tot.n+'</td><td>'+fmtUSD(tot.ing)+'</td><td>'+fmtUSD(tot.cogs)+'</td><td>'+fmtUSD(bruta)+'</td><td>'+fmtUSD(tot.gas)+'</td><td><span class="'+(neta>=0?'pos':'neg')+'">'+fmtUSD(neta)+'</span></td><td>'+(tot.ing>0?(neta/tot.ing*100).toFixed(1):'0.0')+'%</td>';
      tb.appendChild(tr);
    }
  }

  /* ===================== BOOT ===================== */
  let booted = false;
  async function bootApp(){
    document.getElementById('saleDate').value = todayLocal();
    document.getElementById('expDate').value = todayLocal();
    await refreshAllData();
    refreshProductCalc();
    renderAll();
    booted = true;
  }

  /* ===================== INDICADOR DE CONEXIÓN ===================== */
  (function(){
    const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16.2a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/><path class="slash" d="M3 3l18 18"/></svg><span class="net-t"></span>';
    const els = [document.getElementById('netStatus'), document.getElementById('netStatusLogin')].filter(Boolean);
    els.forEach(e => e.innerHTML = ICON);
    let state = 'ok', timer = null, first = true;
    const TITLES = { ok:'Conectado al servidor', slow:'Conexión lenta: puede tardar en guardar', off:'Sin conexión: no se puede registrar ni guardar' };
    function setState(s){
      const prev = state; state = s;
      els.forEach(e => { e.dataset.state = s; e.title = TITLES[s]; e.setAttribute('aria-label', TITLES[s]); });
      if(!first && prev !== s){
        if(s === 'off') showToast('Sin conexión: no se puede registrar ni guardar hasta que vuelva.');
        else if(prev === 'off') showToast('Conexión restablecida.');
      }
      first = false;
    }
    async function check(){
      if(!navigator.onLine){ setState('off'); return; }
      const ctl = new AbortController(), t0 = performance.now(), to = setTimeout(()=>ctl.abort(), 8000);
      try{
        const r = await fetch(SUPABASE_URL + '/auth/v1/health', { headers:{ apikey: SUPABASE_ANON_KEY }, cache:'no-store', signal: ctl.signal });
        clearTimeout(to);
        if(!r.ok && r.status >= 500){ setState('off'); return; }
        setState((performance.now() - t0) > 2000 ? 'slow' : 'ok');
      }catch(e){ clearTimeout(to); setState('off'); }
    }
    function schedule(){ clearInterval(timer); timer = setInterval(check, 20000); }
    window.addEventListener('online', check);
    window.addEventListener('offline', ()=> setState('off'));
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) check(); });
    // Sin conexión no se deja guardar nada: se frena el envío de cualquier formulario
    document.addEventListener('submit', ev => {
      if(state === 'off' || !navigator.onLine){
        ev.preventDefault(); ev.stopImmediatePropagation();
        showToast('Sin conexión: no se pudo registrar. Espera a que el indicador vuelva a "En línea".');
      }
    }, true);
    check(); schedule();
  })();

  checkSession();
})();


  (function(){
    var box=document.getElementById('loginPhotos'); if(!box) return;
    var imgs=box.querySelectorAll('img'), k=0;
    setInterval(function(){
      if(document.getElementById('loginScreen').style.display==='none') return;
      imgs[k].classList.remove('on'); k=(k+1)%imgs.length; imgs[k].classList.add('on');
    },4500);
  })();
