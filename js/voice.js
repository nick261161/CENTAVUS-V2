/* ==========================================================================
   CENTAVUS — ASSISTENTE DE VOZ
   ---------------------------------------------------------------------------
   Fala e entende português do Brasil (Web Speech API), com campo de texto
   como alternativa quando o microfone não está disponível (ex.: file://,
   navegador sem suporte ou permissão negada).

   Comandos:
     • Navegação      — "abrir cartões", "ir para metas", "mostrar relatórios"
     • Lançar gasto   — "gastei cinquenta reais no almoço"
     • Lançar entrada — "recebi três mil de salário"
     • Resumos        — "quanto gastei este mês", "como está meu saldo"
     • Por categoria  — "quanto gastei em transporte"
     • Privacidade    — "mostrar valores" / "ocultar valores"
     • Notificações   — "ler notificações"
     • Ajuda          — "ajuda" / "comandos"
     • Silêncio       — "pare de falar" / "silêncio"
   Atalho de teclado: Alt+V abre/fecha e ouve.
   ========================================================================== */
'use strict';

(function () {

    /* ===================== ESTADO INTERNO ===================== */
    let cvvPanel = null, cvvLog = null, cvvInput = null, cvvStatus = null, cvvFab = null;
    let cvvRec = null, cvvListening = false, cvvVoice = null, cvvInited = false, cvvDeniedLogged = false;

    /* ===================== UTIL ===================== */
    function cvv$(id) { return document.getElementById(id); }

    function cvvNorm(s) {
        return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    }

    function cvvMoneyWords(v) {
        const n = Math.abs(Number(v) || 0);
        const reais = Math.floor(n);
        const cent = Math.round((n - reais) * 100);
        let f = reais.toLocaleString('pt-BR') + (reais === 1 ? ' real' : ' reais');
        if (cent > 0) f += ' e ' + cent + (cent === 1 ? ' centavo' : ' centavos');
        return f;
    }

    /* fala com voz pt-BR, se disponível */
    function cvvSpeak(text) {
        if (!('speechSynthesis' in window)) return;
        try {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(String(text));
            u.lang = 'pt-BR';
            u.rate = 1.04;
            u.pitch = 1;
            if (cvvVoice) u.voice = cvvVoice;
            window.speechSynthesis.speak(u);
        } catch (e) { /* silêncio: o app não pode quebrar por TTS */ }
    }

    function cvvPickVoice() {
        try {
            const vs = window.speechSynthesis.getVoices() || [];
            cvvVoice = vs.find(v => /^pt[-_]BR/i.test(v.lang))
                || vs.find(v => /^pt/i.test(v.lang))
                || null;
        } catch (e) { cvvVoice = null; }
    }

    /* ===================== LOG DA CONVERSA (XSS-safe) ===================== */
    function cvvLogAdd(who, text) {
        if (!cvvLog) return;
        const row = document.createElement('div');
        row.className = 'cvv-msg ' + who;
        const ic = document.createElement('i');
        ic.className = 'fa-solid ' + (who === 'user' ? 'fa-user' : 'fa-wand-magic-sparkles');
        const p = document.createElement('span');
        p.textContent = text;           /* sempre texto: nunca HTML do usuário */
        row.appendChild(ic);
        row.appendChild(p);
        cvvLog.appendChild(row);
        while (cvvLog.children.length > 24) cvvLog.removeChild(cvvLog.firstChild);
        cvvLog.scrollTop = cvvLog.scrollHeight;
    }

    function cvvSetStatus(text, listening) {
        if (!cvvStatus) return;
        cvvStatus.innerHTML = '';
        if (listening) {
            const wave = document.createElement('span');
            wave.className = 'cvv-wave';
            for (let i = 0; i < 3; i++) wave.appendChild(document.createElement('i'));
            cvvStatus.appendChild(wave);
        }
        const s = document.createElement('span');
        s.textContent = text;
        cvvStatus.appendChild(s);
    }

    /* ===================== NÚMEROS POR EXTENSO ===================== */
    const CVV_ONES = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9 };
    const CVV_SPECIAL = { dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19 };
    const CVV_TENS = { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 };
    const CVV_HUNDREDS = { cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900 };

    function cvvNumberFromWords(t) {
        let total = 0, cur = 0, any = false;
        const tokens = cvvNorm(t).replace(/[^a-z0-9\s,]/g, ' ').split(/\s+/);
        for (const w of tokens) {
            if (CVV_ONES[w] != null) { cur += CVV_ONES[w]; any = true; }
            else if (CVV_SPECIAL[w] != null) { cur += CVV_SPECIAL[w]; any = true; }
            else if (CVV_TENS[w] != null) { cur += CVV_TENS[w]; any = true; }
            else if (CVV_HUNDREDS[w] != null) { cur += CVV_HUNDREDS[w]; any = true; }
            else if (w === 'mil') { total += (cur || 1) * 1000; cur = 0; any = true; }
            else if (/^\d+([.,]\d+)?$/.test(w)) { total += parseFloat(w.replace(',', '.')); any = true; }
        }
        return any ? total + cur : NaN;
    }

    /* extrai o valor falado/digitado: dígitos ("50,00", "1.234", "3000") ou extenso */
    function cvvExtractNumber(t) {
        const m = /(\d[\d.,]*)/.exec(t);
        if (m) {
            let raw = m[1].replace(/[^\d.,]/g, '');
            /* formato brasileiro: ponto = milhar, vírgula = decimal */
            if (raw.indexOf(',') > -1) raw = raw.replace(/\./g, '').replace(',', '.');
            else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
            const n = parseFloat(raw);
            if (!isNaN(n) && n > 0) return n;
        }
        const byWord = cvvNumberFromWords(t);
        return (!isNaN(byWord) && byWord > 0) ? byWord : NaN;
    }

    /* ===================== CATEGORIAS POR PALAVRA-CHAVE ===================== */
    const CVV_CATS = {
        'Alimentação': ['almoco', 'almocei', 'jantar', 'janta', 'mercado', 'comida', 'lanche', 'cafe', 'restaurante', 'pizza', 'ifood', 'padaria', 'acougue', 'feira', 'marmita', 'sushi', 'hamburguer', 'esfiha', 'cafezinho', 'lanche'],
        'Transporte': ['uber', 'taxi', 'onibus', 'metro', 'gasolina', 'combustivel', 'estacionamento', 'pedagio', 'passagem', 'corrida', 'alcool'],
        'Lazer': ['cinema', 'jogo', 'bar', 'cerveja', 'show', 'festa', 'netflix', 'spotify', 'streaming', 'viagem', 'passeio', 'balada', 'livro', 'parque'],
        'Roupas': ['roupa', 'camisa', 'calca', 'calcado', 'sapato', 'tenis', 'vestido', 'jaqueta', 'blusa', 'bota']
    };
    const CVV_VERBS_OUT = ['gastei', 'paguei', 'comprei', 'investi', 'doei', 'desembolsei', 'torrei', 'assinalei'];
    const CVV_VERBS_IN = ['recebi', 'ganhei', 'rendeu', 'entrou', 'depositaram', 'reembolsaram', 'reembolsei'];
    const CVV_FILLER = ['de', 'no', 'na', 'em', 'com', 'para', 'pra', 'o', 'a', 'os', 'as', 'do', 'da', 'dos', 'das', 'meu', 'minha', 'uns', 'umas', 'reais', 'real', 'brl', 'hoje', 'ontem', 'amanha', 'mes', 'mespassado', 'mil', 'e', 'cartao', 'credito', 'debito', 'pix', 'dinheiro'];

    /* remove uma palavra do texto ORIGINAL preservando acentos e maiúsculas:
       "gastei 45 no almoço" → remove "almoco" mesmo com o "ç"/"ã" do original */
    function cvvAccentRe(word) {
        const map = { a: '[aáàâãä]', e: '[eéèêë]', i: '[iíìîï]', o: '[oóòôõö]', u: '[uúùûü]', c: '[cç]' };
        return String(word).split('').map(ch => map[ch] || ch).join('');
    }
    function cvvStrip(text, word) {
        try {
            return text.replace(new RegExp('(^|\\s)' + cvvAccentRe(word) + '(?=\\s|$|[,.!?:;])', 'gi'), '$1');
        } catch (e) { return text; }
    }

    /* ===================== PAINEL / FAB ===================== */
    function cvvBuildUI() {
        if (cvvInited || !document.body) return;
        cvvInited = true;

        cvvFab = document.createElement('button');
        cvvFab.id = 'cvVoiceFab';
        cvvFab.className = 'cvv-fab';
        cvvFab.type = 'button';
        cvvFab.setAttribute('aria-label', 'Assistente de voz (Alt+V)');
        cvvFab.title = 'Assistente de voz — Alt+V';
        cvvFab.innerHTML = '<i class="fa-solid fa-microphone-lines"></i><span class="cvv-fab-ring"></span><span class="cvv-fab-ring cvv-fab-ring2"></span>';
        cvvFab.addEventListener('click', cvvToggle);

        cvvPanel = document.createElement('div');
        cvvPanel.id = 'cvVoicePanel';
        cvvPanel.className = 'cvv-panel cvv-hidden';
        cvvPanel.setAttribute('role', 'dialog');
        cvvPanel.setAttribute('aria-label', 'Assistente de voz Centavus');

        const head = document.createElement('div');
        head.className = 'cvv-head';
        head.innerHTML = '<div class="cvv-title"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Assistente Centavus</span></div>';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'cvv-close';
        close.setAttribute('aria-label', 'Fechar assistente');
        close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        close.addEventListener('click', cvvHide);
        head.appendChild(close);
        cvvPanel.appendChild(head);

        cvvStatus = document.createElement('div');
        cvvStatus.className = 'cvv-status';
        cvvPanel.appendChild(cvvStatus);

        cvvLog = document.createElement('div');
        cvvLog.className = 'cvv-log';
        cvvPanel.appendChild(cvvLog);

        const chipsWrap = document.createElement('div');
        chipsWrap.className = 'cvv-chips';
        ['Abrir cartões', 'Quanto gastei este mês?', 'Gastei 45 reais no almoço', 'Recebi 3000 de salário', 'Como está meu saldo?', 'Ajuda'].forEach(c => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'cvv-chip';
            chip.textContent = c;
            chip.addEventListener('click', () => cvvRun(c));
            chipsWrap.appendChild(chip);
        });
        cvvPanel.appendChild(chipsWrap);

        const row = document.createElement('form');
        row.className = 'cvv-input-row';
        cvvInput = document.createElement('input');
        cvvInput.type = 'text';
        cvvInput.placeholder = 'Digite um comando…';
        cvvInput.setAttribute('aria-label', 'Comando do assistente');
        const send = document.createElement('button');
        send.type = 'submit';
        send.className = 'cvv-send';
        send.setAttribute('aria-label', 'Enviar comando');
        send.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
        row.appendChild(cvvInput);
        row.appendChild(send);
        row.addEventListener('submit', e => {
            e.preventDefault();
            const v = cvvInput.value.trim();
            if (!v) return;
            cvvInput.value = '';
            cvvRun(v);
        });
        cvvPanel.appendChild(row);

        document.body.appendChild(cvvPanel);
        document.body.appendChild(cvvFab);

        cvvSetStatus('Toque no microfone e fale, ou digite aqui. Alt+V abre o assistente.', false);
    }

    function cvvShow() {
        cvvPanel.classList.remove('cvv-hidden');
        cvvFab.classList.add('cvv-open');
        setTimeout(() => cvvInput && cvvInput.focus(), 80);
    }
    function cvvHide() {
        cvvPanel.classList.add('cvv-hidden');
        cvvFab.classList.remove('cvv-open');
        cvvStopListen();
    }
    function cvvToggle() {
        if (cvvPanel.classList.contains('cvv-hidden')) { cvvShow(); cvvStartListen(); }
        else cvvHide();
    }

    /* ===================== RECONHECIMENTO DE VOZ ===================== */
    function cvvRecClass() {
        return window.SpeechRecognition || window.webkitSpeechRecognition || null;
    }

    function cvvStartListen() {
        const Rec = cvvRecClass();
        if (!Rec) {
            cvvSetStatus('Microfone indisponível aqui — use o campo de texto abaixo.', false);
            return;
        }
        if (cvvListening) return;
        try {
            cvvRec = new Rec();
            cvvRec.lang = 'pt-BR';
            cvvRec.interimResults = true;
            cvvRec.maxAlternatives = 1;
            cvvRec.continuous = false;

            cvvRec.onstart = () => {
                cvvListening = true;
                cvvFab.classList.add('cvv-listening');
                cvvSetStatus('Ouvindo…', true);
            };
            cvvRec.onresult = (ev) => {
                let interim = '', final = '';
                for (let i = ev.resultIndex; i < ev.results.length; i++) {
                    const r = ev.results[i];
                    if (r.isFinal) final += r[0].transcript;
                    else interim += r[0].transcript;
                }
                if (interim) cvvSetStatus('“' + interim + '”', true);
                if (final) cvvRun(final.trim());
            };
            cvvRec.onerror = (ev) => {
                cvvListening = false;
                cvvFab.classList.remove('cvv-listening');
                if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
                    cvvSetStatus('Permissão de microfone negada. Você ainda pode digitar comandos.', false);
                    if (!cvvDeniedLogged) {
                        cvvDeniedLogged = true;
                        cvvLogAdd('bot', 'Permissão de microfone negada. Libere o microfone nas permissões do navegador ou use o campo de texto.');
                    }
                } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
                    cvvSetStatus('Não consegui ouvir. Tente de novo.', false);
                }
            };
            cvvRec.onend = () => {
                cvvListening = false;
                cvvFab.classList.remove('cvv-listening');
                if (cvvPanel && !cvvPanel.classList.contains('cvv-hidden')) cvvSetStatus('Ouvir de novo (toque no microfone) ou digite abaixo.', false);
            };
            cvvRec.start();
        } catch (e) {
            cvvSetStatus('Não consegui iniciar o microfone.', false);
        }
    }

    function cvvStopListen() {
        try { if (cvvRec) cvvRec.stop(); } catch (e) {}
        cvvListening = false;
        if (cvvFab) cvvFab.classList.remove('cvv-listening');
    }

    /* ===================== RESPOSTAS DO APP ===================== */
    function cvvOnLoginScreen() {
        const ls = cvv$('loginScreen');
        return !!(ls && ls.offsetParent !== null);
    }

    function cvvFocusTx() {
        return (typeof txNoMesFoco === 'function') ? txNoMesFoco : null;
    }

    function cvvSumMonth(fn) {
        const dentro = cvvFocusTx();
        let inc = 0, out = 0;
        (Array.isArray(transactions) ? transactions : []).forEach(t => {
            const a = Number(t.amount) || 0;
            if (dentro && !dentro(t)) return;
            if (a > 0) inc += a; else out += Math.abs(a);
        });
        return { inc: inc, out: out, saldo: inc - out };
    }

    function cvvMonthName() {
        if (typeof selectedMonthIndex !== 'undefined' && selectedMonthIndex >= 0 && typeof monthsLabels !== 'undefined') {
            return monthsLabels[selectedMonthIndex];
        }
        return 'todos os meses';
    }

    function cvvSummary() {
        if (isPrivacyHidden) {
            const msg = 'Seus valores estão ocutos pelo modo de privacidade. Diga “mostrar valores” para eu ler os números.';
            cvvLogAdd('bot', msg); cvvSpeak(msg); return;
        }
        const t = cvvSumMonth();
        const mes = cvvMonthName();
        let txt = 'Em ' + mes + ': entradas de ' + cvvMoneyWords(t.inc) + ', saídas de ' + cvvMoneyWords(t.out) +
            ' e saldo de ' + cvvMoneyWords(t.saldo) + '.';

        const fat = (Array.isArray(cards) ? cards : []).reduce((s, c) => s + Math.max(0, Number(c.fatura) || 0), 0);
        if (fat > 0) txt += ' Cartões com fatura em aberto somam ' + cvvMoneyWords(fat) + '.';

        const cof = Number((typeof cofrinho !== 'undefined' && cofrinho) ? cofrinho.saldo : 0) || 0;
        if (cof > 0) txt += ' Cofrinho com ' + cvvMoneyWords(cof) + '.';

        const estourados = (typeof budgets !== 'undefined' ? budgets : []).filter(b => {
            const spent = transactions.filter(x => x.cat === b.name && x.amount < 0).reduce((s, x) => s + Math.abs(x.amount), 0);
            return b.limit > 0 && spent / b.limit >= 0.9;
        }).map(b => b.name);
        if (estourados.length) txt += ' Atenção: orçamento de ' + estourados.join(', ') + ' está quase no limite.';

        cvvLogAdd('bot', txt);
        cvvSpeak(txt);
    }

    function cvvCategoryQuery(text) {
        const nv = cvvNorm(text);
        const names = (typeof categoriesData !== 'undefined' ? categoriesData : []).map(c => c.name);
        let cat = names.find(n => nv.indexOf(cvvNorm(n)) >= 0);
        if (!cat && typeof budgets !== 'undefined') {
            const b = budgets.find(x => nv.indexOf(cvvNorm(x.name)) >= 0);
            if (b) cat = b.name;
        }
        if (!cat) return false;
        const dentro = cvvFocusTx();
        const sum = transactions.filter(t => {
            if (dentro && !dentro(t)) return false;
            if (cvvNorm(t.cat) !== cvvNorm(cat)) return false;
            return /quanto/.test(nv) ? (Number(t.amount) || 0) < 0 : true;
        }).reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
        const verb = /recebi|entradas|receita/.test(nv) ? 'entrou' : 'gastou';
        if (isPrivacyHidden) {
            const m = 'Valores ocultos pelo modo de privacidade. Diga “mostrar valores”.';
            cvvLogAdd('bot', m); cvvSpeak(m); return true;
        }
        const txt = 'Em ' + cat + ', ' + verb + ' ' + cvvMoneyWords(sum) + ' em ' + cvvMonthName() + '.';
        cvvLogAdd('bot', txt); cvvSpeak(txt);
        return true;
    }

    /* ===================== LANÇAR MOVIMENTAÇÃO POR VOZ ===================== */
    function cvvAddTransaction(text) {
        const nv = cvvNorm(text);

        /* tipo: quem vem primeiro manda (recebi antes de gastei = entrada) */
        let iOut = Infinity, iIn = Infinity;
        CVV_VERBS_OUT.forEach(v => { const i = nv.indexOf(v); if (i >= 0) iOut = Math.min(iOut, i); });
        CVV_VERBS_IN.forEach(v => { const i = nv.indexOf(v); if (i >= 0) iIn = Math.min(iIn, i); });
        const isIncome = iIn < iOut;

        const val = cvvExtractNumber(text);
        if (isNaN(val)) {
            const msg = 'Não consegui identificar o valor. Diga, por exemplo: “gastei cinquenta reais no almoço”.';
            cvvLogAdd('bot', msg); cvvSpeak(msg);
            return;
        }

        /* categoria por palavra-chave (só para saída) */
        let cat = 'Outros', matched = null;
        if (!isIncome) {
            for (const name of Object.keys(CVV_CATS)) {
                matched = CVV_CATS[name].find(k => nv.indexOf(k) >= 0);
                if (matched) { cat = name; break; }
            }
        }

        /* descrição: remove verbos, valor, categoria e palavras de preenchimento
           do texto ORIGINAL (preserva acentos: "almoço" não vira "almoco") */
        let desc = text;
        CVV_VERBS_OUT.concat(CVV_VERBS_IN).forEach(v => { desc = cvvStrip(desc, v); });
        if (matched) desc = cvvStrip(desc, matched);
        desc = desc.replace(/\d[\d.,]*/g, ' ');
        /* também remove números por extenso usados no valor ("três mil" → desc só com "salário") */
        Object.keys(CVV_ONES).concat(Object.keys(CVV_SPECIAL), Object.keys(CVV_TENS), Object.keys(CVV_HUNDREDS), ['mil', 'centavos', 'centavo']).forEach(w => { desc = cvvStrip(desc, w); });
        CVV_FILLER.forEach(w => { desc = cvvStrip(desc, w); });
        desc = desc.replace(/\s+/g, ' ').replace(/^[\s,.:;]+|[\s,.:;]+$/g, '');
        if (!desc) desc = isIncome ? 'Entrada' : cat;
        desc = desc.charAt(0).toUpperCase() + desc.slice(1).toLowerCase();

        /* preenche e submete o formulário real do app (mesmos efeitos colaterais) */
        try {
            const form = cvv$('transactionForm');
            if (!form) {
                const msg = 'O formulário de movimentação não está disponível agora.';
                cvvLogAdd('bot', msg); cvvSpeak(msg);
                return;
            }
            const typeRadio = document.querySelector('input[name="type"][value="' + (isIncome ? 'receita' : 'despesa') + '"]');
            if (typeRadio) typeRadio.checked = true;
            if (typeof updateCategoryOptions === 'function') updateCategoryOptions();

            cvv$('inputDesc').value = desc;
            cvv$('inputValue').value = String(val.toFixed(2));

            const sel = cvv$('inputCategory');
            if (sel) {
                if (isIncome) {
                    const opt = Array.prototype.find.call(sel.options, o => o.value === 'Receita');
                    if (opt) sel.value = 'Receita';
                } else if (Array.prototype.some.call(sel.options, o => o.value === cat)) {
                    sel.value = cat;
                }
            }

            /* mês/ano de referência = mês atual */
            const now = new Date();
            const mSel = cvv$('inputMonth');
            if (mSel && typeof MONTHS_SHORT !== 'undefined') {
                if (Array.prototype.some.call(mSel.options, o => o.value === MONTHS_SHORT[now.getMonth()])) {
                    mSel.value = MONTHS_SHORT[now.getMonth()];
                }
            }
            if (typeof fillYearSelect === 'function') fillYearSelect(toIso(now));
            const ySel = cvv$('inputYear');
            if (ySel && Array.prototype.some.call(ySel.options, o => Number(o.value) === now.getFullYear())) {
                ySel.value = String(now.getFullYear());
            }

            /* pagamento padrão: pix (radio já vem marcado; garante após edições antigas) */
            const pix = document.querySelector('input[name="pay"][value="pix"]');
            if (pix) pix.checked = true;
            if (typeof updatePayFields === 'function') updatePayFields();

            if (form.requestSubmit) form.requestSubmit();
            else handleAddTransaction(new Event('submit'));

            const txt = (isIncome ? 'Entrada registrada: ' : 'Gasto registrado: ') + desc + ', ' + cvvMoneyWords(val) +
                (!isIncome && cat !== 'Outros' && desc !== cat ? ', categoria ' + cat : '') + '.';
            cvvLogAdd('bot', txt);
            cvvSpeak(txt);
        } catch (e) {
            const msg = 'Deu ruim ao registrar. Você pode lançar pela tela de nova transação.';
            cvvLogAdd('bot', msg); cvvSpeak(msg);
        }
    }

    /* ===================== NAVEGAÇÃO E MODAIS ===================== */
    const CVV_NAV = [
        { keys: ['dashboard', 'inicio', 'painel', 'resumo geral', 'home'], section: 'dashboard' },
        { keys: ['movimentacoes', 'transacoes', 'extrato', 'lancamentos', 'transactions'], section: 'movimentacoes' },
        { keys: ['cartoes', 'fatura', 'faturas'], section: 'cartoes' },
        { keys: ['contas', 'account'], section: 'contas' },
        { keys: ['cofrinho', 'poupanca', 'reserva'], section: 'cofrinho' },
        { keys: ['metas', 'objetivos', 'goal'], section: 'metas' },
        { keys: ['relatorios', 'analise', 'relatorio', 'graficos', 'reports'], section: 'relatorios' }
    ];

    function cvvGoto(section) {
        if (typeof setActiveNav === 'function') {
            setActiveNav(null, section);
            const txt = 'Abrindo ' + section + '.';
            cvvLogAdd('bot', txt);
            cvvSpeak('Abrindo ' + (section === 'relatorios' ? 'relatórios' : section) + '.');
            return true;
        }
        return false;
    }

    function cvvHelp() {
        const txt = 'Você pode falar: “abrir cartões”, “nova transação”, “gastei cinquenta reais no almoço”, ' +
            '“recebi três mil de salário”, “quanto gastei este mês”, “como está meu saldo”, “quanto gastei em alimentação”, ' +
            '“ler notificações”, “mostrar valores”, “ocultar valores” ou “pare de falar”.';
        cvvLogAdd('bot', txt);
        cvvSpeak('Posso lançar gastos e entradas por voz, abrir telas e resumir suas finanças. Veja os exemplos na tela.');
    }

    /* ===================== ROTEADOR DE COMANDOS ===================== */
    function cvvRun(text) {
        if (!text) return;
        cvvLogAdd('user', text);
        const nv = cvvNorm(text);

        if (cvvOnLoginScreen()) {
            const msg = 'Entre na sua conta para usar o assistente.';
            cvvLogAdd('bot', msg); cvvSpeak(msg);
            return;
        }

        /* silêncio */
        if (/(pare|cala|cala a boca|silencio|silenciar|nao fale|stop)/.test(nv) && !/valor/.test(nv)) {
            try { window.speechSynthesis.cancel(); } catch (e) {}
            cvvLogAdd('bot', 'Certo, em silêncio.');
            cvvSetStatus('Silêncio. Toque no microfone quando quiser.', false);
            return;
        }

        /* ajuda */
        if (/^(ajuda|help|comandos|o que voce faz|como funciona|comandos de voz)/.test(nv) || /\bajuda\b/.test(nv)) {
            cvvHelp(); return;
        }

        /* privacidade */
        if (/(mostrar|exibir|liberar|revelar).*(valores|numeros|saldos)/.test(nv)) {
            if (typeof togglePrivacyMode === 'function' && isPrivacyHidden) togglePrivacyMode();
            const m = 'Valores visíveis de novo.'; cvvLogAdd('bot', m); cvvSpeak(m); return;
        }
        if (/(ocultar|esconder|esconder|privacidade|modo privado).*(valores|numeros|saldos|tudo)|ocultar tudo/.test(nv)) {
            if (typeof togglePrivacyMode === 'function' && !isPrivacyHidden) togglePrivacyMode();
            const m = 'Valores ocultados.'; cvvLogAdd('bot', m); cvvSpeak(m); return;
        }

        /* notificações */
        if (/notificac|avisos|sino\b/.test(nv) && !/quanto/.test(nv)) {
            if (typeof toggleNotifications === 'function') toggleNotifications();
            const unread = (typeof notifItems !== 'undefined' ? notifItems : []).length;
            const txt = unread ? 'Notificações abertas. Você tem ' + unread + ' avisos.' : 'Notificações abertas. Nenhuma novidade.';
            cvvLogAdd('bot', txt); cvvSpeak(txt);
            return;
        }

        /* resumos financeiros */
        if (/(quanto gastei|quanto recebi|quanto entrou|quanto saiu|saldo|resumo|como (estou|esta|estao|minhas financas)|minhas financas|fechamento|como esta a situacao|quanto tenho)/.test(nv)) {
            if (/\b(em|do|da)\s+[a-zà-ú\s]{2,20}$/.test(nv) && cvvCategoryQuery(nv)) return;
            cvvSummary(); return;
        }
        if (/quanto.*\b(em|no|na)\b/.test(nv) && cvvCategoryQuery(nv)) return;

        /* modais de cadastro */
        if (/(nova|novo|adicionar|cadastrar|criar|registrar).*(transacao|movimentacao|lancamento)/.test(nv)) {
            if (typeof openModal === 'function') { openModal(); const t = 'Abrindo nova transação.'; cvvLogAdd('bot', t); cvvSpeak(t); }
            return;
        }
        if (/(nova|nova meta|criar meta|adicionar meta|lancar meta)/.test(nv) && /meta/.test(nv)) {
            if (typeof openGoalModal === 'function') { openGoalModal(); const t = 'Abrindo nova meta.'; cvvLogAdd('bot', t); cvvSpeak(t); }
            return;
        }
        if (/(novo|adicionar|cadastrar|criar).*(cartao)/.test(nv)) {
            if (typeof openCardModal === 'function') { openCardModal(); const t = 'Abrindo novo cartão.'; cvvLogAdd('bot', t); cvvSpeak(t); }
            return;
        }
        if (/(nova|novo|adicionar|cadastrar|criar).*(conta)/.test(nv)) {
            if (typeof openAccountModal === 'function') { openAccountModal(); const t = 'Abrindo nova conta.'; cvvLogAdd('bot', t); cvvSpeak(t); }
            return;
        }
        if (/(nova|novo|fazer|fazer transferencia|transferencia)/.test(nv) && /transfer/.test(nv)) {
            if (typeof openTransferModal === 'function') { openTransferModal(); const t = 'Abrindo transferência.'; cvvLogAdd('bot', t); cvvSpeak(t); }
            return;
        }
        if (/(novo|nova|criar|definir|editar).*(orcamento|limite)/.test(nv)) {
            if (typeof openBudgetModal === 'function') { openBudgetModal(); const t = 'Abrindo orçamentos.'; cvvLogAdd('bot', t); cvvSpeak(t); }
            return;
        }
        if (/renda fixa|investimento|cdb|tesouro/.test(nv)) {
            if (typeof openRendaFixa === 'function') { openRendaFixa(); const t = 'Abrindo renda fixa.'; cvvLogAdd('bot', t); cvvSpeak(t); }
            return;
        }
        if (/configurac|minha conta|meu perfil|perfil/.test(nv)) {
            if (typeof openSettings === 'function') { openSettings(); const t = 'Abrindo configurações.'; cvvLogAdd('bot', t); cvvSpeak(t); }
            return;
        }

        /* lançar movimentação por voz */
        if (CVV_VERBS_OUT.some(v => nv.indexOf(v) === 0) || CVV_VERBS_IN.some(v => nv.indexOf(v) === 0) ||
            CVV_VERBS_OUT.some(v => nv.indexOf(v) >= 0) || CVV_VERBS_IN.some(v => nv.indexOf(v) >= 0)) {
            cvvAddTransaction(text); return;
        }

        /* navegação com "abrir/ir para/mostrar" */
        if (/(abrir|abre|ir para|vai para|mostrar|mostra|exibir|exibe|ir em)/.test(nv)) {
            for (const item of CVV_NAV) {
                if (item.keys.some(k => nv.indexOf(k) >= 0)) { cvvGoto(item.section); return; }
            }
        }

        /* fallback amigável */
        const msg = 'Não entendi. Diga “ajuda” para ver exemplos do que posso fazer.';
        cvvLogAdd('bot', msg);
        cvvSpeak(msg);
    }

    /* ===================== BOOT ===================== */
    function cvvBoot() {
        cvvBuildUI();
        cvvPickVoice();
        if ('speechSynthesis' in window) {
            try { window.speechSynthesis.onvoiceschanged = cvvPickVoice; } catch (e) {}
        }
        if (!cvvRecClass()) {
            cvvFab.innerHTML = '<i class="fa-solid fa-keyboard"></i>';
            cvvFab.title = 'Assistente Centavus (texto — microfone não suportado aqui)';
            cvvSetStatus('Microfone não suportado neste navegador/página. Use os exemplos ou digite comandos.', false);
        }

        document.addEventListener('keydown', (ev) => {
            if (ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
                ev.preventDefault();
                cvvToggle();
                return;
            }
            if (ev.key === 'Escape' && cvvPanel && !cvvPanel.classList.contains('cvv-hidden')) {
                const tag = (ev.target && ev.target.tagName) || '';
                if (tag !== 'INPUT' && tag !== 'TEXTAREA') cvvHide();
            }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cvvBoot);
    else cvvBoot();

    /* expõe o que a UI externa pode precisar */
    window.cvVoice = { open: cvvShow, hide: cvvHide, run: cvvRun, speak: cvvSpeak };

})();
