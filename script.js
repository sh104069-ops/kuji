/* =========================================================
   パーティーくじ＆ルーレット  script.js
   ・ホスト端末が「親」となり、参加者のスマホとWebRTC（PeerJS）で直接通信します。
   ・データはホスト端末のブラウザ（localStorage）に保存されます。
   ========================================================= */
'use strict';

(() => {
  // ---------------------------------------------------------
  // 定数
  // ---------------------------------------------------------
  const PEER_PREFIX = 'partykuji-v1-';      // PeerJSのID接頭辞（他アプリとの衝突防止）
  const LS_HOST = 'partykuji_host_v1';
  const LS_GUEST = 'partykuji_guest_v1_';
  const MAX_CAP = 50;
  const DEFAULT_ATTRACTIONS = [
    '開会のあいさつ', '乾杯の音頭', 'ひとこと自己紹介', '近況報告',
    '一発芸', '中締め', '締めのあいさつ', '一本締め'
  ];
  const WHEEL_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2', '#f783ac'];

  // ---------------------------------------------------------
  // ユーティリティ
  // ---------------------------------------------------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
  const show = (el, on = true) => el && el.classList.toggle('hidden', !on);

  function randInt(n) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  }
  function randId(len = 10) {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[randInt(chars.length)];
    return s;
  }
  function roomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[randInt(chars.length)];
    return s;
  }
  function cleanName(s) {
    return String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20);
  }
  function loadJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量不足など */ } }
  function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch { /* 非対応 */ } }
  function timeStr(ts) { const d = new Date(ts); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
  function whoLabel(number, name) { return `${number != null ? number + '番 ' : ''}${name}さん`; }

  let toastTimer = 0;
  function toast(msg, ms = 2400) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function setStatus(el, kind, text) {
    el.dataset.kind = kind;
    $('.txt', el).textContent = text;
  }

  function showView(name) {
    ['home', 'host', 'guest'].forEach(v => show($('#view-' + v), v === name));
    window.scrollTo(0, 0);
  }

  function confetti(count = 60) {
    const layer = $('#confetti-layer');
    for (let i = 0; i < count; i++) {
      const c = document.createElement('span');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = WHEEL_COLORS[i % WHEEL_COLORS.length];
      c.style.animationDuration = (1.8 + Math.random() * 1.8) + 's';
      c.style.animationDelay = (Math.random() * 0.4) + 's';
      c.style.transform = `rotate(${Math.random() * 360}deg)`;
      layer.appendChild(c);
      setTimeout(() => c.remove(), 4500);
    }
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // 画面を消灯させない（対応ブラウザのみ）
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* 非対応・拒否 */ }
  }

  // ---------------------------------------------------------
  // モーダル
  // ---------------------------------------------------------
  const Modal = {
    locked: false,
    onClose: null,
    open(html, { wide = false, onClose = null } = {}) {
      const m = $('#modal');
      $('#modal-body').innerHTML = html;
      m.classList.toggle('wide', wide);
      this.setLocked(false);
      this.onClose = onClose;
      show(m);
      return $('#modal-body');
    },
    setLocked(v) { this.locked = v; $('#modal').classList.toggle('locked', v); },
    close(force = false) {
      if (this.locked && !force) return;
      show($('#modal'), false);
      $('#modal-body').innerHTML = '';
      const f = this.onClose;
      this.onClose = null;
      this.setLocked(false);
      if (f) f();
    }
  };
  $('#modal-x').addEventListener('click', () => Modal.close());
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') Modal.close(); });

  // ---------------------------------------------------------
  // 抽選演出（くじ／ルーレット）
  //   stage.start()      … 演出開始（結果待ち）
  //   stage.finish(n)    … 番号 n で止める（Promise）
  //   stage.cancel()     … 中断
  // ---------------------------------------------------------
  function createStage(container, mode, capacity) {
    return mode === 'roulette' ? createRoulette(container, capacity) : createKuji(container);
  }

  function createRoulette(container, capacity) {
    container.innerHTML = '<div class="roulette"><div class="pointer"></div><canvas></canvas><div class="roulette-hub">?</div></div>';
    const canvas = $('canvas', container);
    const hub = $('.roulette-hub', container);
    const SIZE = 320;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const N = Math.max(1, capacity);
    const seg = (Math.PI * 2) / N;
    const TAU = Math.PI * 2;
    let rot = 0, raf = 0, spinning = false, highlight = -1, last = 0;
    const fontPx = N > 40 ? 9 : N > 30 ? 11 : N > 20 ? 13 : N > 10 ? 16 : 22;

    function colorOf(i) {
      let c = i % WHEEL_COLORS.length;
      if (i === N - 1 && N > 1 && c === 0) c = 3; // 最初と最後が同色にならないように
      return WHEEL_COLORS[c];
    }
    function draw() {
      const c = SIZE / 2, r = c - 6;
      ctx.clearRect(0, 0, SIZE, SIZE);
      for (let i = 0; i < N; i++) {
        const a0 = -Math.PI / 2 + i * seg + rot;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.arc(c, c, r, a0, a0 + seg);
        ctx.closePath();
        ctx.fillStyle = highlight === i ? '#ffffff' : colorOf(i);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.lineWidth = N > 30 ? 1 : 2;
        ctx.stroke();
        ctx.save();
        ctx.translate(c, c);
        ctx.rotate(a0 + seg / 2);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1f2240';
        ctx.font = `bold ${fontPx}px sans-serif`;
        ctx.fillText(String(i + 1), r - 8, 0);
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(c, c, r, 0, TAU);
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#1f2240';
      ctx.stroke();
    }
    draw();

    return {
      start() {
        cancelAnimationFrame(raf);
        spinning = true;
        highlight = -1;
        hub.textContent = '?';
        hub.classList.remove('win');
        last = performance.now();
        const loop = t => {
          const dt = Math.min(0.05, (t - last) / 1000);
          last = t;
          rot = (rot + 15 * dt) % TAU;
          draw();
          if (spinning) raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      },
      finish(number) {
        return new Promise(resolve => {
          spinning = false;
          cancelAnimationFrame(raf);
          const i = number - 1;
          const jitter = (Math.random() - 0.5) * seg * 0.6;
          const desired = -(i + 0.5) * seg + jitter;                 // 針（真上）に i 番の扇形が来る角度
          let delta = (((desired - rot) % TAU) + TAU) % TAU;
          delta += TAU * 3;                                           // 3周以上回してから止める
          const from = rot, T = 3800, t0 = performance.now();
          const ease = x => 1 - Math.pow(1 - x, 3);
          const step = t => {
            const x = Math.min(1, (t - t0) / T);
            rot = from + delta * ease(x);
            draw();
            if (x < 1) {
              raf = requestAnimationFrame(step);
            } else {
              rot %= TAU;
              highlight = i;
              draw();
              hub.textContent = number;
              hub.classList.add('win');
              resolve();
            }
          };
          raf = requestAnimationFrame(step);
        });
      },
      cancel() { spinning = false; cancelAnimationFrame(raf); }
    };
  }

  function createKuji(container) {
    container.innerHTML = `
      <div class="kuji">
        <div class="kuji-ticket hidden"><div class="ticket-inner"><span class="ticket-no"></span><span class="ticket-ban">番</span></div></div>
        <div class="kuji-box"><div class="kuji-hole"></div><div class="kuji-label">くじ</div></div>
      </div>`;
    const box = $('.kuji-box', container);
    const ticket = $('.kuji-ticket', container);
    let t0 = 0;
    return {
      start() {
        t0 = performance.now();
        show(ticket, false);
        ticket.classList.remove('pop');
        box.classList.add('shaking');
      },
      async finish(n) {
        await sleep(Math.max(0, 1800 - (performance.now() - t0)));
        box.classList.remove('shaking');
        $('.ticket-no', container).textContent = n;
        show(ticket, true);
        void ticket.offsetWidth; // アニメーション再始動
        ticket.classList.add('pop');
        await sleep(1350);
      },
      cancel() { box.classList.remove('shaking'); }
    };
  }

  // =========================================================
  // ホスト
  // =========================================================
  let H = null;                       // ホストの状態（保存対象）
  const host = {
    peer: null,
    conns: new Map(),                 // clientId -> DataConnection
    restarting: false,
    bound: false,
    sort: 'number',
    feeUnpaidOnly: false
  };

  function newHostState() {
    return {
      v: 1,
      roomId: roomCode(),
      eventName: '懇親会',
      eventType: 'party',             // party=飲み会 / rec=レクリエーション
      capacity: 20,
      mode: 'kuji',                   // kuji / roulette
      fee: 3000,
      attractions: DEFAULT_ATTRACTIONS.map(name => ({ id: randId(6), name })),
      selectedAttrId: null,
      optExclude: true,
      optNumbered: true,
      participants: [],               // {id,name,number,paid,paidClaim,amount,source,joinedAt}
      history: [],                    // {attraction, participantId, name, number, ts}
      current: null,                  // 現在の指名
      createdAt: Date.now()
    };
  }

  const saveHost = () => saveJSON(LS_HOST, H);
  const hs = () => $('#h-status');
  const feeOf = p => (p.amount != null ? p.amount : H.fee);
  const isConnected = id => { const c = host.conns.get(id); return !!(c && c.open); };
  const findP = id => H.participants.find(p => p.id === id);

  function joinUrl() {
    return `${location.origin}${location.pathname}?room=${H.roomId}`;
  }

  // 状態変更 → 保存・再描画・全参加者へ送信
  function commit() {
    saveHost();
    renderHostAll();
    broadcast();
  }

  function startHost(state) {
    H = state;
    // 古いデータとの互換
    H.participants = Array.isArray(H.participants) ? H.participants : [];
    H.history = Array.isArray(H.history) ? H.history : [];
    H.attractions = Array.isArray(H.attractions) ? H.attractions : [];
    saveHost();
    history.replaceState(null, '', `${location.pathname}?host=1`);
    showView('host');
    bindHostUI();
    fillSettingsForm();
    renderQR();
    renderHostAll();
    hostConnect();
    requestWakeLock();
  }

  // ---------- 通信 ----------
  function hostConnect() {
    if (typeof Peer === 'undefined') {
      setStatus(hs(), 'error', '通信ライブラリを読み込めません');
      return;
    }
    if (host.peer && !host.peer.destroyed) { try { host.peer.destroy(); } catch { /* noop */ } }
    setStatus(hs(), 'wait', '接続準備中…');

    const peer = new Peer(PEER_PREFIX + H.roomId, { debug: 1 });
    host.peer = peer;

    peer.on('open', () => { if (peer === host.peer) setStatus(hs(), 'ok', '受付中'); });
    peer.on('connection', conn => setupHostConn(conn));
    peer.on('disconnected', () => {
      if (peer !== host.peer || peer.destroyed) return;
      setStatus(hs(), 'wait', '再接続中…');
      setTimeout(() => {
        if (peer === host.peer && !peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); } catch { scheduleHostRestart(); }
        }
      }, 1500);
    });
    peer.on('error', err => {
      console.warn('[host]', err.type, err);
      if (peer !== host.peer) return;
      if (err.type === 'unavailable-id') {
        // 再読み込み直後は前のIDがしばらく残るため待って再試行
        setStatus(hs(), 'wait', 'ルームの再開待ち…');
        scheduleHostRestart(6000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(err.type)) {
        setStatus(hs(), 'wait', '再接続中…');
        scheduleHostRestart(4000);
      } else if (err.type === 'browser-incompatible') {
        setStatus(hs(), 'error', 'このブラウザは非対応です');
      }
    });
  }

  function scheduleHostRestart(ms = 4000) {
    if (host.restarting) return;
    host.restarting = true;
    setTimeout(() => { host.restarting = false; hostConnect(); }, ms);
  }

  function setupHostConn(conn) {
    conn.on('data', msg => {
      try { handleGuestMsg(conn, msg); } catch (e) { console.error(e); }
    });
    conn.on('close', () => dropConn(conn));
    conn.on('error', () => dropConn(conn));
  }

  function dropConn(conn) {
    if (conn.clientId && host.conns.get(conn.clientId) === conn) {
      host.conns.delete(conn.clientId);
      renderPeople();
      renderStats();
    }
  }

  function send(conn, msg) {
    try { if (conn && conn.open) conn.send(msg); } catch (e) { console.warn(e); }
  }

  function guestView(cid) {
    const p = findP(cid);
    const cur = H.current;
    return {
      type: 'state',
      event: { name: H.eventName, type: H.eventType, capacity: H.capacity, mode: H.mode, fee: H.fee },
      joined: H.participants.length,
      you: p ? { name: p.name, number: p.number, paid: p.paid, paidClaim: p.paidClaim, amount: feeOf(p) } : null,
      current: cur ? {
        id: cur.id, attraction: cur.attraction, name: cur.name, number: cur.number,
        ts: cur.ts, isYou: cur.participantId === cid
      } : null
    };
  }
  function sendState(conn) { if (conn.clientId) send(conn, guestView(conn.clientId)); }
  function broadcast() { host.conns.forEach(c => sendState(c)); }

  function pickNumber() {
    const used = new Set(H.participants.map(p => p.number).filter(n => n != null));
    const free = [];
    for (let n = 1; n <= H.capacity; n++) if (!used.has(n)) free.push(n);
    return free.length ? free[randInt(free.length)] : null;
  }

  function handleGuestMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const cid = String(msg.clientId || '').slice(0, 40);
    if (!cid) return;

    // 同じ参加者の古い接続を置き換え
    if (conn.clientId !== cid) {
      conn.clientId = cid;
      const old = host.conns.get(cid);
      host.conns.set(cid, conn);
      if (old && old !== conn) { try { old.close(); } catch { /* noop */ } }
    }
    const p = findP(cid);

    switch (msg.type) {
      case 'hello':
        sendState(conn);
        renderPeople();
        renderStats();
        break;

      case 'join': {
        const name = cleanName(msg.name);
        if (!name) { send(conn, { type: 'error', message: '名前を入力してください' }); return; }
        if (p) {
          p.name = name;
        } else {
          if (H.participants.length >= H.capacity) {
            send(conn, { type: 'error', message: `定員（${H.capacity}人）に達しています。幹事さんに声をかけてください。` });
            return;
          }
          H.participants.push({ id: cid, name, number: null, paid: false, paidClaim: false, amount: null, source: 'guest', joinedAt: Date.now() });
          toast(`${name}さんが参加しました`);
        }
        commit();
        break;
      }

      case 'draw': {
        if (!p) { sendState(conn); return; }
        if (p.number == null) {
          const n = pickNumber();
          if (n == null) { send(conn, { type: 'error', message: '空いている番号がありません。幹事さんに声をかけてください。' }); return; }
          p.number = n;
          saveHost();
        }
        send(conn, { type: 'drawResult', number: p.number });
        commit();
        break;
      }

      case 'claimPaid':
        if (p) {
          p.paidClaim = !!msg.value;
          if (p.paidClaim) toast(`💴 ${p.name}さんから「支払い済み」の申告がありました`, 3500);
          commit();
        }
        break;
    }
  }

  // ---------- UI結合（1回だけ） ----------
  function bindHostUI() {
    if (host.bound) return;
    host.bound = true;

    // タブ
    $('#h-tabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-tab]');
      if (b) switchTab(b.dataset.tab);
    });

    // QR
    $('#btn-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(joinUrl()); toast('URLをコピーしました'); }
      catch { $('#join-url').select(); document.execCommand('copy'); toast('URLをコピーしました'); }
    });
    $('#btn-qr-big').addEventListener('click', () => {
      const body = Modal.open(`
        <div class="qr-big">
          <h2>${esc(H.eventName)}</h2>
          <p>スマホのカメラで読み取って参加してください</p>
          <div class="qr-box" id="qr-big-box"></div>
          <div>ルームコード</div>
          <div class="big-code">${esc(H.roomId)}</div>
        </div>`, { wide: true });
      drawQR($('#qr-big-box', body), 8);
    });

    // 手動追加
    $('#add-form').addEventListener('submit', e => {
      e.preventDefault();
      const name = cleanName($('#add-name').value);
      if (!name) return toast('名前を入力してください');
      if (H.participants.length >= H.capacity) return toast(`定員（${H.capacity}人）に達しています。設定で人数を増やしてください。`);
      H.participants.push({ id: 'm_' + randId(10), name, number: null, paid: false, paidClaim: false, amount: null, source: 'host', joinedAt: Date.now() });
      $('#add-name').value = '';
      commit();
      toast(`${name}さんを追加しました`);
    });

    $('#sort-sel').addEventListener('change', e => { host.sort = e.target.value; renderPeople(); });

    // 参加者一覧の操作
    $('#ptbody').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const p = findP(b.closest('tr').dataset.id);
      if (!p) return;
      const act = b.dataset.act;
      if (act === 'rename') {
        const v = cleanName(prompt('名前を変更', p.name));
        if (v) { p.name = v; commit(); }
      } else if (act === 'draw') {
        hostDraw(p.id);
      } else if (act === 'undo') {
        if (confirm(`${p.name}さんの番号（${p.number}番）を取り消しますか？\n本人がもう一度引けるようになります。`)) {
          p.number = null;
          commit();
        }
      } else if (act === 'remove') {
        if (confirm(`${p.name}さんを一覧から削除しますか？`)) {
          H.participants = H.participants.filter(x => x.id !== p.id);
          commit();
        }
      }
    });

    // アトラクション
    $('#attr-list').addEventListener('click', e => {
      const x = e.target.closest('.x');
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const id = chip.dataset.id;
      if (x) {
        const a = H.attractions.find(a => a.id === id);
        if (a && confirm(`「${a.name}」を削除しますか？`)) {
          H.attractions = H.attractions.filter(a => a.id !== id);
          if (H.selectedAttrId === id) H.selectedAttrId = null;
          commit();
        }
        return;
      }
      H.selectedAttrId = id;
      saveHost();
      renderAttractions();
    });
    $('#attr-add-form').addEventListener('submit', e => {
      e.preventDefault();
      const name = String($('#attr-add').value).trim().slice(0, 30);
      if (!name) return;
      const a = { id: randId(6), name };
      H.attractions.push(a);
      H.selectedAttrId = a.id;
      $('#attr-add').value = '';
      commit();
    });
    $('#opt-exclude').addEventListener('change', e => { H.optExclude = e.target.checked; saveHost(); });
    $('#opt-numbered').addEventListener('change', e => { H.optNumbered = e.target.checked; saveHost(); });
    $('#btn-designate').addEventListener('click', designate);
    $('#current-card').addEventListener('click', e => {
      if (e.target.closest('#btn-clear-current')) { H.current = null; commit(); }
    });
    $('#btn-hist-clear').addEventListener('click', () => {
      if (!H.history.length) return;
      if (confirm('指名履歴をリセットしますか？\n（「指名された人を除外」の対象もリセットされます）')) {
        H.history = [];
        H.current = null;
        commit();
      }
    });

    // 会費
    $('#fee-unpaid-only').addEventListener('change', e => { host.feeUnpaidOnly = e.target.checked; renderFee(); });
    $('#fee-tbody').addEventListener('change', e => {
      const tr = e.target.closest('tr');
      const p = tr && findP(tr.dataset.id);
      if (!p) return;
      if (e.target.matches('.paid-toggle')) {
        p.paid = e.target.checked;
        if (p.paid) p.paidClaim = false;
        commit();
      } else if (e.target.matches('.amount-input')) {
        const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
        p.amount = v === H.fee ? null : v;
        commit();
      }
    });

    // 設定
    $('#s-name').addEventListener('change', e => {
      H.eventName = String(e.target.value).trim().slice(0, 30) || '懇親会';
      e.target.value = H.eventName;
      commit();
    });
    $('#s-type').addEventListener('change', e => { H.eventType = e.target.value; commit(); fillSettingsForm(); });
    $('#s-mode').addEventListener('change', e => { H.mode = e.target.value; commit(); });
    $('#s-fee').addEventListener('change', e => {
      H.fee = Math.max(0, Math.floor(Number(e.target.value) || 0));
      e.target.value = H.fee;
      commit();
    });
    $('#s-cap').addEventListener('change', e => {
      let v = Math.floor(Number(e.target.value) || 0);
      const maxNum = Math.max(0, ...H.participants.map(p => p.number || 0));
      const min = Math.max(1, H.participants.length, maxNum);
      if (v > MAX_CAP) { v = MAX_CAP; toast(`人数は最大${MAX_CAP}人です`); }
      if (v < min) { v = min; toast(`参加者数・割り当て済みの番号があるため ${min} 人未満にはできません`, 3500); }
      H.capacity = v;
      e.target.value = v;
      commit();
    });

    // データ
    $('#btn-csv').addEventListener('click', exportCSV);
    $('#btn-backup').addEventListener('click', () => {
      download(`${H.eventName}_バックアップ_${H.roomId}.json`, JSON.stringify(H, null, 2), 'application/json');
      toast('バックアップを保存しました');
    });
    $('#file-restore').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        if (!obj || !obj.roomId || !Array.isArray(obj.participants)) throw new Error('形式が違います');
        if (!confirm(`「${obj.eventName}」（参加者${obj.participants.length}人）のデータを読み込みます。\n現在のデータは上書きされます。よろしいですか？\n\n※元の端末でホスト画面を開いている場合は閉じてください。`)) return;
        saveJSON(LS_HOST, obj);
        location.reload();
      } catch (err) {
        alert('バックアップを読み込めませんでした：' + err.message);
      }
    });
    $('#btn-reset-numbers').addEventListener('click', () => {
      if (confirm('全員の番号を取り消しますか？\n（参加者はもう一度くじを引けるようになります）')) {
        H.participants.forEach(p => { p.number = null; });
        commit();
      }
    });
    $('#btn-end').addEventListener('click', () => {
      if (!confirm('この会のデータをすべて削除して、新しい会を作りますか？\n（必要ならCSVやバックアップを先に保存してください）')) return;
      try { host.peer && host.peer.destroy(); } catch { /* noop */ }
      localStorage.removeItem(LS_HOST);
      location.href = location.pathname;
    });
  }

  function switchTab(name) {
    $$('#h-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-panel').forEach(p => show(p, p.id === 'tab-' + name));
    window.scrollTo({ top: 0 });
  }

  function fillSettingsForm() {
    $('#s-name').value = H.eventName;
    $('#s-type').value = H.eventType;
    $('#s-cap').value = H.capacity;
    $('#s-mode').value = H.mode;
    $('#s-fee').value = H.fee;
    show($('#s-fee-wrap'), H.eventType === 'party');
    $('#opt-exclude').checked = !!H.optExclude;
    $('#opt-numbered').checked = !!H.optNumbered;
  }

  // ---------- 描画 ----------
  function drawQR(el, cell = 4) {
    if (typeof qrcode === 'undefined') {
      el.innerHTML = '<p class="hint">QRライブラリを読み込めませんでした。URLを共有してください。</p>';
      return;
    }
    const qr = qrcode(0, 'M');
    qr.addData(joinUrl());
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
  }
  function renderQR() {
    $('#join-url').value = joinUrl();
    drawQR($('#qr-box'));
  }

  function renderHostAll() {
    $('#h-event-name').textContent = H.eventName;
    $('#h-room').textContent = H.roomId;
    document.title = `${H.eventName}｜ホスト`;
    const feeOn = H.eventType === 'party';
    show($('#tab-btn-fee'), feeOn);
    if (!feeOn && !$('#tab-fee').classList.contains('hidden')) switchTab('people');
    renderStats();
    renderPeople();
    renderAttractions();
    renderCurrent();
    renderHistory();
    renderFee();
  }

  function stat(k, v, cls = '') {
    return `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  }

  function renderStats() {
    const ps = H.participants;
    const drawn = ps.filter(p => p.number != null).length;
    const online = ps.filter(p => isConnected(p.id)).length;
    let html = stat('参加者', `${ps.length}<small> / ${H.capacity}</small>`)
      + stat('番号決定', `${drawn}<small>人</small>`)
      + stat('接続中', `${online}<small>台</small>`, 'ok');
    if (H.eventType === 'party') {
      const paid = ps.filter(p => p.paid).length;
      html += stat('会費支払済', `${paid}<small> / ${ps.length}</small>`, paid < ps.length ? 'warn' : 'ok');
    }
    $('#stats').innerHTML = html;
  }

  function sortedParticipants(mode) {
    const ps = [...H.participants];
    if (mode === 'join') ps.sort((a, b) => a.joinedAt - b.joinedAt);
    else if (mode === 'name') ps.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    else ps.sort((a, b) => (a.number ?? 999) - (b.number ?? 999) || a.joinedAt - b.joinedAt);
    return ps;
  }

  function renderPeople() {
    const ps = sortedParticipants(host.sort);
    show($('#p-empty'), ps.length === 0);
    $('#ptbody').innerHTML = ps.map(p => {
      const state = p.source === 'host'
        ? '<span class="badge b-manual">手動</span>'
        : isConnected(p.id) ? '<span class="badge b-on">📱接続中</span>' : '<span class="badge b-off">📱オフライン</span>';
      const num = p.number != null ? `<span class="num-badge">${p.number}</span>` : '<span class="num-none">—</span>';
      const ops = (p.number == null
        ? '<button class="btn btn-sm btn-primary" data-act="draw">抽選</button>'
        : '<button class="btn btn-sm" data-act="undo">取消</button>')
        + '<button class="btn btn-sm btn-danger-ghost" data-act="remove">削除</button>';
      return `<tr data-id="${esc(p.id)}">
        <td class="num">${num}</td>
        <td class="name">${esc(p.name)}<button class="icon-btn" data-act="rename" title="名前を変更">✎</button></td>
        <td>${state}</td>
        <td class="ops">${ops}</td>
      </tr>`;
    }).join('');
  }

  function renderAttractions() {
    if (H.selectedAttrId && !H.attractions.some(a => a.id === H.selectedAttrId)) H.selectedAttrId = null;
    if (!H.selectedAttrId && H.attractions.length) H.selectedAttrId = H.attractions[0].id;
    $('#attr-list').innerHTML = H.attractions.length
      ? H.attractions.map(a => `<span class="chip ${a.id === H.selectedAttrId ? 'selected' : ''}" data-id="${esc(a.id)}">${esc(a.name)}<button class="x" title="削除">×</button></span>`).join('')
      : '<p class="empty">アトラクションを追加してください。</p>';
  }

  function renderCurrent() {
    const c = H.current;
    $('#current-card').innerHTML = c
      ? `<div class="card-head"><h2>参加者のスマホに表示中</h2><button class="btn btn-sm btn-ghost" id="btn-clear-current">表示を消す</button></div>
         <div class="current-box">
           <div class="attr">${esc(c.attraction)}</div>
           <div class="who">${esc(whoLabel(c.number, c.name))}</div>
           <div class="lbl">${timeStr(c.ts)} に指名</div>
         </div>`
      : '<h2>参加者のスマホに表示中</h2><p class="empty">現在、指名はありません。</p>';
  }

  function renderHistory() {
    show($('#hist-empty'), H.history.length === 0);
    $('#hist-list').innerHTML = H.history.map(h =>
      `<li><span class="t">${timeStr(h.ts)}</span><span><span class="a">${esc(h.attraction)}</span>　${esc(whoLabel(h.number, h.name))}</span></li>`
    ).join('');
  }

  function renderFee() {
    if (H.eventType !== 'party') return;
    const ps = sortedParticipants('number');
    const paid = ps.filter(p => p.paid);
    const claim = ps.filter(p => !p.paid && p.paidClaim).length;
    const total = ps.reduce((s, p) => s + feeOf(p), 0);
    const got = paid.reduce((s, p) => s + feeOf(p), 0);
    $('#fee-summary').innerHTML =
      stat('支払済', `${paid.length}<small> / ${ps.length}人</small>`, 'ok')
      + stat('未払い', `${ps.length - paid.length}<small>人</small>`, ps.length - paid.length ? 'warn' : 'ok')
      + stat('申告あり（未確認）', `${claim}<small>人</small>`, claim ? 'warn' : '')
      + stat('集金額', `${got.toLocaleString('ja-JP')}<small>円</small>`)
      + stat('予定総額', `${total.toLocaleString('ja-JP')}<small>円</small>`);

    const list = host.feeUnpaidOnly ? ps.filter(p => !p.paid) : ps;
    show($('#fee-empty'), list.length === 0);
    $('#fee-empty').textContent = ps.length ? '未払いの人はいません 🎉' : '参加者がいません。';
    $('#fee-tbody').innerHTML = list.map(p => `
      <tr data-id="${esc(p.id)}" class="${p.paid ? 'is-paid' : ''}">
        <td class="num">${p.number != null ? `<span class="num-badge">${p.number}</span>` : '<span class="num-none">—</span>'}</td>
        <td class="name">${esc(p.name)}</td>
        <td><input type="number" class="amount-input" min="0" step="100" value="${feeOf(p)}" inputmode="numeric"></td>
        <td class="claim">${p.paidClaim && !p.paid ? '<span class="badge b-claim">申告あり</span>' : ''}</td>
        <td class="paid"><input type="checkbox" class="paid-toggle" ${p.paid ? 'checked' : ''} aria-label="支払済"></td>
      </tr>`).join('');
  }

  // ---------- ホスト端末での抽選（スマホがない人用） ----------
  function hostDraw(pid) {
    const p = findP(pid);
    if (!p) return;
    const label = H.mode === 'roulette' ? 'ルーレットを回す' : 'くじを引く';
    const body = Modal.open(`
      <h2 class="modal-title">${esc(p.name)}さんの抽選</h2>
      <div class="stage" id="m-stage"></div>
      <button class="btn btn-primary btn-xl btn-block" id="m-go">${label}</button>`);
    const stage = createStage($('#m-stage', body), H.mode, H.capacity);
    const btn = $('#m-go', body);
    btn.addEventListener('click', async () => {
      if (btn.dataset.done) { Modal.close(); return; }
      const cur = findP(pid);
      if (!cur) { Modal.close(true); return; }
      if (cur.number == null) {
        const n = pickNumber();
        if (n == null) { toast('空いている番号がありません'); return; }
        cur.number = n;
        saveHost();            // 先に確保（他の人と重複しないように）
      }
      btn.disabled = true;
      btn.textContent = '抽選中…';
      Modal.setLocked(true);
      stage.start();
      await sleep(400);
      await stage.finish(cur.number);
      Modal.setLocked(false);
      confetti();
      commit();
      btn.disabled = false;
      btn.dataset.done = '1';
      btn.textContent = `${cur.number}番に決定！（閉じる）`;
    }, { once: false });
  }

  // ---------- ランダム指名 ----------
  let designating = false;
  async function designate() {
    if (designating) return;
    const attr = H.attractions.find(a => a.id === H.selectedAttrId);
    if (!attr) return toast('アトラクションを選んでください');
    let cands = H.participants.filter(p => !H.optNumbered || p.number != null);
    if (!cands.length) return toast(H.optNumbered ? '番号が決まっている参加者がいません' : '参加者がいません');
    if (H.optExclude) {
      const done = new Set(H.history.map(h => h.participantId));
      const rest = cands.filter(p => !done.has(p.id));
      if (!rest.length) {
        if (!confirm('対象の全員がすでに指名されています。\n指名済みの人も含めて抽選しますか？')) return;
      } else {
        cands = rest;
      }
    }
    designating = true;
    const winner = cands[randInt(cands.length)];

    const body = Modal.open(`
      <div class="designate">
        <div class="d-attr">${esc(attr.name)}</div>
        <div class="slot" id="slot"><span>？</span></div>
        <div class="d-msg" id="d-msg">だれかな…？</div>
        <div class="d-actions hidden" id="d-actions">
          <button class="btn btn-outline btn-lg" id="d-again">もう一度指名</button>
          <button class="btn btn-primary btn-lg" id="d-close">閉じる</button>
        </div>
      </div>`, { wide: true });
    Modal.setLocked(true);

    const slot = $('#slot', body);
    const slotText = $('#slot span', body);
    const pool = cands.length > 1 ? cands : [winner];
    let idx = randInt(pool.length);
    const STEPS = 28;
    for (let s = 0; s < STEPS; s++) {
      const p = pool[(idx + s) % pool.length];
      slotText.textContent = whoLabel(p.number, p.name);
      await sleep(40 + s * s * 0.35);
    }
    slotText.textContent = whoLabel(winner.number, winner.name);
    slot.classList.add('win');
    $('#d-msg', body).textContent = 'お願いします！ 🎉';

    const rec = {
      id: randId(8), attraction: attr.name, participantId: winner.id,
      name: winner.name, number: winner.number, ts: Date.now()
    };
    H.current = rec;
    H.history.unshift({ ...rec });
    commit();
    confetti(80);
    vibrate(120);
    Modal.setLocked(false);
    designating = false;

    show($('#d-actions', body), true);
    $('#d-close', body).onclick = () => Modal.close();
    $('#d-again', body).onclick = () => { Modal.close(); designate(); };
  }

  // ---------- CSV ----------
  function exportCSV() {
    const fee = H.eventType === 'party';
    const head = ['番号', '名前', '参加方法'];
    if (fee) head.push('会費(円)', '支払済', '本人申告');
    head.push('指名されたアトラクション');
    const rows = [head];
    sortedParticipants('number').forEach(p => {
      const r = [p.number ?? '', p.name, p.source === 'host' ? '手動追加' : 'スマホ'];
      if (fee) r.push(feeOf(p), p.paid ? '済' : '未', p.paidClaim ? 'あり' : '');
      r.push(H.history.filter(h => h.participantId === p.id).map(h => h.attraction).reverse().join(' / '));
      rows.push(r);
    });
    const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download(`${H.eventName}_参加者一覧.csv`, csv, 'text/csv;charset=utf-8');
  }

  // =========================================================
  // 参加者（ゲスト）
  // =========================================================
  const G = {
    room: '', cid: '', name: '', seenTs: 0,
    peer: null, conn: null, state: null,
    drawing: false, stage: null, stageKey: '',
    retryTimer: 0, openTimer: 0, drawTimer: 0, bound: false
  };
  const gs = () => $('#g-status');
  const saveGuest = () => saveJSON(LS_GUEST + G.room, { cid: G.cid, name: G.name, seenTs: G.seenTs });

  function startGuest(room) {
    G.room = String(room).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const saved = loadJSON(LS_GUEST + G.room) || {};
    G.cid = saved.cid || randId(16);
    G.name = saved.name || '';
    G.seenTs = saved.seenTs || 0;
    saveGuest();
    showView('guest');
    bindGuestUI();
    renderGuest();
    guestConnect();
    requestWakeLock();
  }

  function guestConnect() {
    clearTimeout(G.retryTimer);
    if (typeof Peer === 'undefined') {
      guestOffline('通信ライブラリを読み込めませんでした。ページを再読み込みしてください。');
      return;
    }
    if (!G.state) setStatus(gs(), 'wait', '接続中…');

    if (!G.peer || G.peer.destroyed) {
      const peer = new Peer({ debug: 1 });
      G.peer = peer;
      peer.on('open', () => { if (peer === G.peer) openConn(); });
      peer.on('disconnected', () => {
        if (peer !== G.peer || peer.destroyed) return;
        setTimeout(() => { if (peer === G.peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch { /* noop */ } } }, 1500);
      });
      peer.on('error', err => {
        console.warn('[guest]', err.type, err);
        if (peer !== G.peer) return;
        if (err.type === 'peer-unavailable') {
          guestOffline('ホストが見つかりません。ホストの画面が開いているか確認してください。再試行しています…');
          scheduleGuestRetry(4000);
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          guestOffline('ネットワークに接続できません。再試行しています…');
          try { peer.destroy(); } catch { /* noop */ }
          scheduleGuestRetry(4000);
        } else if (err.type === 'browser-incompatible') {
          guestOffline('このブラウザは対応していません。Safari / Chrome でお試しください。');
        }
      });
    } else if (G.peer.open) {
      openConn();
    } else if (G.peer.disconnected) {
      try { G.peer.reconnect(); } catch { /* noop */ }
    }
  }

  function openConn() {
    if (G.conn && G.conn.open) return;
    const old = G.conn;
    G.conn = null;
    if (old) { try { old.close(); } catch { /* noop */ } }

    const conn = G.peer.connect(PEER_PREFIX + G.room, { reliable: true });
    G.conn = conn;
    clearTimeout(G.openTimer);
    G.openTimer = setTimeout(() => {
      if (G.conn === conn && !conn.open) {
        guestOffline('ホストに接続できません。再試行しています…');
        scheduleGuestRetry(500);
      }
    }, 10000);

    conn.on('open', () => {
      clearTimeout(G.openTimer);
      setStatus(gs(), 'ok', '接続中');
      show($('#g-offline'), false);
      gsend({ type: 'hello' });
    });
    conn.on('data', handleHostMsg);
    conn.on('close', () => {
      if (G.conn !== conn) return;
      guestOffline('ホストとの接続が切れました。再接続しています…');
      scheduleGuestRetry(2500);
    });
    conn.on('error', e => console.warn('[guest conn]', e));
  }

  function scheduleGuestRetry(ms) {
    clearTimeout(G.retryTimer);
    G.retryTimer = setTimeout(guestConnect, ms);
  }

  function guestOffline(msg) {
    setStatus(gs(), 'error', 'オフライン');
    if (G.state) {
      $('#g-offline').textContent = msg;
      show($('#g-offline'), true);
    } else {
      $('#g-conn-msg').textContent = msg;
    }
  }

  function gsend(msg) {
    if (G.conn && G.conn.open) {
      G.conn.send({ ...msg, clientId: G.cid });
      return true;
    }
    toast('ホストに接続されていません。少し待ってからもう一度お試しください。');
    return false;
  }

  function handleHostMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      G.state = msg;
      renderGuest();
    } else if (msg.type === 'drawResult') {
      if (G.drawing) finishGuestDraw(msg.number);
    } else if (msg.type === 'error') {
      toast(msg.message || 'エラーが発生しました', 4000);
      if (G.drawing) {
        clearTimeout(G.drawTimer);
        G.drawing = false;
        G.stage && G.stage.cancel();
        renderGuest();
      }
      const btn = $('#g-join button');
      btn.disabled = false;
    }
  }

  function bindGuestUI() {
    if (G.bound) return;
    G.bound = true;

    $('#g-join').addEventListener('submit', e => {
      e.preventDefault();
      const name = cleanName($('#g-name').value);
      if (!name) return toast('名前を入力してください');
      G.name = name;
      saveGuest();
      if (gsend({ type: 'join', name })) {
        const btn = $('#g-join button');
        btn.disabled = true;
        setTimeout(() => { btn.disabled = false; }, 3000);
      }
    });

    $('#btn-g-draw').addEventListener('click', guestDraw);

    $('#g-fee').addEventListener('click', e => {
      const b = e.target.closest('[data-claim]');
      if (b) gsend({ type: 'claimPaid', value: b.dataset.claim === '1' });
    });

    $('#you-ok').addEventListener('click', () => show($('#you-overlay'), false));
  }

  function ensureStage(mode, capacity) {
    const key = mode + ':' + capacity;
    if (G.stage && G.stageKey === key) return;
    G.stage = createStage($('#g-stage'), mode, capacity);
    G.stageKey = key;
  }

  function guestDraw() {
    if (G.drawing || !G.stage) return;
    if (!gsend({ type: 'draw' })) return;
    G.drawing = true;
    const btn = $('#btn-g-draw');
    btn.disabled = true;
    btn.textContent = '抽選中…';
    G.stage.start();
    clearTimeout(G.drawTimer);
    G.drawTimer = setTimeout(() => {
      if (!G.drawing) return;
      G.drawing = false;
      G.stage.cancel();
      toast('ホストから応答がありません。もう一度お試しください。', 3500);
      renderGuest();
    }, 12000);
  }

  async function finishGuestDraw(n) {
    clearTimeout(G.drawTimer);
    await G.stage.finish(n);
    confetti();
    vibrate([80, 40, 80]);
    $('#btn-g-draw').textContent = `${n}番に決まりました！`;
    await sleep(1100);
    G.drawing = false;
    renderGuest();
  }

  function renderGuest() {
    const st = G.state;
    show($('#g-connecting'), !st);
    if (!st) return;

    const ev = st.event;
    $('#g-event-name').textContent = ev.name;
    document.title = `${ev.name}｜パーティーくじ`;
    const you = st.you;

    // 参加登録
    show($('#g-join'), !you);
    if (!you) {
      const inp = $('#g-name');
      if (!inp.value && G.name) inp.value = G.name;
      $('#g-join button').disabled = false;
    }

    // 抽選
    const needDraw = !!you && (you.number == null || G.drawing);
    show($('#g-draw'), needDraw);
    if (needDraw && !G.drawing) {
      ensureStage(ev.mode, ev.capacity);
      const isR = ev.mode === 'roulette';
      $('#g-draw-title').textContent = isR ? 'ルーレットで番号を決めよう！' : 'くじを引いて番号を決めよう！';
      const btn = $('#btn-g-draw');
      btn.disabled = false;
      btn.textContent = isR ? '🎡 ルーレットを回す' : '🎫 くじを引く';
    }

    // 結果
    const showResult = !!you && you.number != null && !G.drawing;
    show($('#g-result'), showResult);
    if (you) {
      $('#g-you-name').textContent = you.name;
      $('#g-number').textContent = you.number ?? '';
    }

    // 指名のお知らせ
    const cur = st.current;
    const ann = $('#g-announce');
    show(ann, !!cur);
    if (cur) {
      ann.classList.toggle('is-you', !!cur.isYou);
      ann.innerHTML = `
        <div class="lbl">🎤 ただいまの指名</div>
        <div class="attr">${esc(cur.attraction)}</div>
        <div class="who">${cur.isYou ? 'あなた（' + esc(whoLabel(cur.number, cur.name)) + '）' : esc(whoLabel(cur.number, cur.name))}</div>`;
      if (cur.ts > G.seenTs) {
        G.seenTs = cur.ts;
        saveGuest();
        if (cur.isYou) {
          $('#you-attr').textContent = cur.attraction;
          show($('#you-overlay'), true);
          vibrate([200, 100, 200, 100, 400]);
          confetti(90);
        } else {
          toast(`🎤 ${cur.attraction}：${whoLabel(cur.number, cur.name)}`, 3500);
          vibrate(60);
          ann.classList.remove('flash');
          void ann.offsetWidth;
          ann.classList.add('flash');
        }
      }
    } else {
      show($('#you-overlay'), false);
    }

    // 会費
    const fee = $('#g-fee');
    const feeOn = ev.type === 'party' && !!you && (you.amount > 0 || you.paid);
    show(fee, feeOn);
    if (feeOn) {
      let stateHtml, action = '';
      if (you.paid) {
        stateHtml = '<span class="fee-state b-paid">✅ 支払い済み</span>';
      } else if (you.paidClaim) {
        stateHtml = '<span class="fee-state b-claim">申告済み（幹事の確認待ち）</span>';
        action = '<button class="btn btn-sm btn-ghost" data-claim="0">申告を取り消す</button>';
      } else {
        stateHtml = '<span class="fee-state b-unpaid">未払い</span>';
        action = '<button class="btn btn-outline btn-block" data-claim="1" style="margin-top:.8rem">💴 支払いました（幹事に知らせる）</button>';
      }
      fee.innerHTML = `
        <h2>会費</h2>
        <div class="fee-box"><span class="amount">${yen(you.amount)}</span>${stateHtml}</div>
        ${action}`;
    }
  }

  // =========================================================
  // ホーム・起動
  // =========================================================
  function showHome() {
    const saved = loadJSON(LS_HOST);
    const resume = $('#btn-resume');
    if (saved && saved.roomId) {
      show(resume, true);
      resume.textContent = `前回の会を再開する（${saved.eventName}・${(saved.participants || []).length}人）`;
    }
    showView('home');
  }

  $('#btn-new').addEventListener('click', () => {
    const saved = loadJSON(LS_HOST);
    if (saved && saved.roomId && !confirm(`前回の会「${saved.eventName}」のデータは削除されます。\n新しい会を作りますか？`)) return;
    const st = newHostState();
    startHost(st);
    switchTab('settings');
    toast('まず会の名前・人数などを設定しましょう', 3000);
  });
  $('#btn-resume').addEventListener('click', () => {
    const saved = loadJSON(LS_HOST);
    if (saved && saved.roomId) startHost(saved);
  });
  $('#code-form').addEventListener('submit', e => {
    e.preventDefault();
    const code = String($('#code-input').value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) return toast('ルームコードを入力してください');
    location.href = `${location.pathname}?room=${code}`;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    requestWakeLock();
    // スマホがスリープから戻ったら再接続
    if (G.room && !(G.conn && G.conn.open)) guestConnect();
    if (H && host.peer && host.peer.disconnected && !host.peer.destroyed) {
      try { host.peer.reconnect(); } catch { scheduleHostRestart(1000); }
    }
  });

  function boot() {
    const q = new URLSearchParams(location.search);
    const room = q.get('room');
    if (room) { startGuest(room); return; }
    const saved = loadJSON(LS_HOST);
    if (q.has('host') && saved && saved.roomId) { startHost(saved); return; }
    showHome();
  }

  boot();
})();
