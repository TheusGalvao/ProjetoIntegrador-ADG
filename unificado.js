    // CONTROLE DE VISIBILIDADE / COLAPSO DAS DIVS (ACORDEÃO / TOGGLE)
    const modulosVisiveis = {
      game: true,
      calibrador: true,
      dashboard: true
    };

    function toggleModulo(nome) {
      const box = document.getElementById('div-' + nome);
      const navBtn = document.getElementById('nav-btn-' + nome);
      const collapseIcon = document.getElementById('collapse-icon-' + nome);
      if (!box) return;

      modulosVisiveis[nome] = !modulosVisiveis[nome];
      const aberto = modulosVisiveis[nome];

      if (aberto) {
        box.classList.remove('collapsed');
        if (navBtn) navBtn.classList.add('active');
        if (collapseIcon) collapseIcon.textContent = '▼';
      } else {
        box.classList.add('collapsed');
        if (navBtn) navBtn.classList.remove('active');
        if (collapseIcon) collapseIcon.textContent = '▲';
      }

      ajustarGridRow();
    }

    // Se uma das duas divs inferiores estiver recolhida, a outra ocupa 100% da linha
    function ajustarGridRow() {
      const row = document.getElementById('modules-row');
      const calAberto = modulosVisiveis.calibrador;
      const dashAberto = modulosVisiveis.dashboard;

      if (!row) return;

      if (calAberto && dashAberto) {
        row.style.gridTemplateColumns = '';
      } else if (calAberto && !dashAberto) {
        row.style.gridTemplateColumns = '1fr';
      } else if (!calAberto && dashAberto) {
        row.style.gridTemplateColumns = '1fr';
      } else {
        row.style.gridTemplateColumns = '1fr 1fr';
      }
    }

    // Estado compartilhado entre os 3 módulos
    let port = null;
    let reader = null;
    let keepReading = false;

    const LIMIAR_DIA_TEMA = 50; // >= 50% ativa Modo Dia (Game) e Tema Claro (Dashboard)
    const INTERVALO_HISTORICO = 5 * 60 * 1000; // 5 minutos em ms
    let ultimoRegistroHistorico = 0;

    // Último estado recebido do Arduino para sincronia imediata
    let estadoAtual = {
      ldr: 0,
      max: 240,
      pct: 0,
      leds: 0,
      condicao: 'Escuro'
    };

    // ========================================================================
    // 1. GERENCIAMENTO DE CONEXÃO USB (WEB SERIAL API - 115200 BPS)
    // ========================================================================
    async function toggleSerial() {
      if (port) {
        await desconectarSerial();
      } else {
        await conectarSerial();
      }
    }

    async function conectarSerial() {
      if (!('serial' in navigator)) {
        alert('Seu navegador não suporta a Web Serial API. Utilize o Google Chrome, Microsoft Edge ou Opera.');
        return;
      }

      try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        keepReading = true;
        sincronizarStatusConexao(true);
        lerSerial();
      } catch (err) {
        console.error('Erro ao conectar à porta serial:', err);
        port = null;
        sincronizarStatusConexao(false);
      }
    }

    async function desconectarSerial() {
      keepReading = false;
      try {
        if (reader) {
          await reader.cancel();
        }
        if (port) {
          await port.close();
        }
      } catch (err) {
        console.error('Erro ao desconectar:', err);
      } finally {
        port = null;
        reader = null;
        sincronizarStatusConexao(false);
      }
    }

    // Atualiza os indicadores de conexão nas 3 Divs simultaneamente
    function sincronizarStatusConexao(conectado) {
      // Div 1: Game
      const gameBtn = document.getElementById('game-btn-conectar');
      const gameStatus = document.getElementById('game-status-text');
      if (conectado) {
        gameBtn.textContent = 'Desconectar USB';
        gameBtn.className = 'btn btn-danger';
        gameStatus.textContent = 'USB CONECTADO';
      } else {
        gameBtn.textContent = 'Conectar USB (Serial)';
        gameBtn.className = 'btn btn-primary';
        gameStatus.textContent = estadoAtual.pct >= LIMIAR_DIA_TEMA ? 'WORKING...' : 'SLEEPING...';
      }

      // Div 2: Calibrador
      const calDot = document.getElementById('cal-dot-status');
      const calTxt = document.getElementById('cal-txt-status');
      const calBtn = document.getElementById('cal-btn-serial');
      if (conectado) {
        calDot.classList.add('connected');
        calTxt.textContent = 'USB Conectado (115200)';
        calBtn.textContent = 'Desconectar';
        calBtn.className = 'btn btn-danger';
      } else {
        calDot.classList.remove('connected');
        calTxt.textContent = 'USB Desconectado';
        calBtn.textContent = 'Conectar USB';
        calBtn.className = 'btn btn-primary';
      }

      // Div 3: Dashboard
      const dashDot = document.getElementById('dash-status-dot');
      const dashTxt = document.getElementById('dash-status-text');
      const dashBtnCon = document.getElementById('dash-btn-conectar');
      const dashBtnDes = document.getElementById('dash-btn-desconectar');
      const demoStatus = document.getElementById('demo-mode-status');
      if (conectado) {
        dashDot.classList.add('connected');
        dashTxt.textContent = 'Conectado ao Arduino Mega';
        dashBtnCon.disabled = true;
        dashBtnDes.disabled = false;
        if (demoStatus) demoStatus.textContent = 'Modo atual: Protótipo Físico Conectado via USB';
      } else {
        dashDot.classList.remove('connected');
        dashTxt.textContent = 'Modo Simulação Virtual (Sem USB)';
        dashBtnCon.disabled = false;
        dashBtnDes.disabled = true;
        if (demoStatus) demoStatus.textContent = 'Modo atual: Simulação Virtual Ativa (Sem USB)';
      }
    }

    // ========================================================================
    // 2. LEITURA E ENVIO DE DADOS (SERIAL USB + FALLBACK WI-FI HTTP + VIRTUAL)
    // ========================================================================
    async function lerSerial() {
      const textDecoder = new TextDecoderStream();
      port.readable.pipeTo(textDecoder.writable).catch(() => { });
      reader = textDecoder.readable.getReader();
      let buffer = '';

      try {
        while (keepReading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            buffer += value;
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              processarLinhaRecebida(line.trim());
            }
          }
        }
      } catch (err) {
        console.warn('Leitura serial encerrada:', err);
      } finally {
        try { reader.releaseLock(); } catch (_) { }
      }
    }

    function processarLinhaRecebida(trimmed) {
      if (!trimmed) return;

      // Caso 1: JSON enviado pelo projeto_ldr_mega.ino -> {"ldr":180,"max":240,"pct":75,"leds":3}
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const dados = JSON.parse(trimmed);
          atualizarTodosOsModulos(dados);
        } catch (e) { }
        return;
      }

      // Caso 2: Texto simples ("Luminosidade: 450") caso use firmware antigo
      const match = trimmed.match(/\d+/);
      if (match) {
        const ldr = parseInt(match[0], 10);
        if (!isNaN(ldr)) {
          const max = estadoAtual.max || 1023;
          const pct = Math.min(100, Math.max(0, Math.round((ldr / max) * 100)));
          const leds = calcularLedsPorPorcentagem(pct);
          atualizarTodosOsModulos({ ldr, max, pct, leds });
        }
      }
    }

    function calcularLedsPorPorcentagem(pct) {
      if (pct <= 0) return 0;
      return Math.min(4, Math.ceil((pct / 100) * 4));
    }

    async function enviarSerial(texto) {
      if (!port || !port.writable) return false;
      try {
        const encoder = new TextEncoder();
        const writer = port.writable.getWriter();
        await writer.write(encoder.encode(texto + '\n'));
        writer.releaseLock();
        return true;
      } catch (e) {
        console.error('Erro ao enviar comando serial:', e);
        return false;
      }
    }

    // Envia comandos de calibração (UP, DOWN, LEFT, RIGHT, AUTO, MAX:valor)
    async function cmd(c) {
      if (port) {
        await enviarSerial(c);
        // Registra no histórico após breve intervalo para refletir a nova calibração
        setTimeout(() => registrarLeituraManual('Calibração (' + c + ')'), 150);
      } else {
        // Caso esteja sem USB, tenta HTTP do ESP8266 ou aplica na Simulação Virtual local
        let atualizadoViaHttp = false;
        if (window.location.protocol.startsWith('http')) {
          try {
            const r = await fetch('/cmd?c=' + encodeURIComponent(c));
            if (r.ok) {
              const dados = await r.json();
              atualizarTodosOsModulos(dados);
              registrarLeituraManual('Calibração (' + c + ')');
              atualizadoViaHttp = true;
            }
          } catch (e) { }
        }

        if (!atualizadoViaHttp) {
          let novoMax = estadoAtual.max || 240;
          if (c === 'LEFT') novoMax -= 20;
          else if (c === 'DOWN') novoMax -= 5;
          else if (c === 'UP') novoMax += 5;
          else if (c === 'RIGHT') novoMax += 20;
          else if (c === 'AUTO') novoMax = Math.max(10, estadoAtual.ldr || 240);
          else if (c.startsWith('MAX:')) novoMax = parseInt(c.split(':')[1], 10) || novoMax;

          novoMax = Math.min(1023, Math.max(10, novoMax));
          const ldr = estadoAtual.ldr;
          const pct = Math.min(100, Math.max(0, Math.round((ldr / novoMax) * 100)));
          const leds = calcularLedsPorPorcentagem(pct);

          atualizarTodosOsModulos({ ldr, max: novoMax, pct, leds });
          registrarLeituraManual('Calibração Virtual (' + c + ')');
        }
      }
    }

    function definirMax() {
      const input = document.getElementById('novoMax');
      const v = input.value;
      if (v) {
        cmd('MAX:' + v);
        input.value = '';
      }
    }

    // ========================================================================
    // 2.5 CONTROLE VIRTUAL DE ILUMINAÇÃO (SIMULAÇÃO SEM PROTÓTIPO FÍSICO 0-100%)
    // ========================================================================
    function simularIluminacaoLDR(valorPct) {
      const pct = Math.min(100, Math.max(0, Number(valorPct)));
      const max = estadoAtual.max || 240;
      const ldr = Math.round((pct / 100) * max);
      const leds = calcularLedsPorPorcentagem(pct);

      if (!port) {
        const calTxt = document.getElementById('cal-txt-status');
        const dashTxt = document.getElementById('dash-status-text');
        const calDot = document.getElementById('cal-dot-status');
        const dashDot = document.getElementById('dash-status-dot');
        if (calTxt) calTxt.textContent = 'Simulação Virtual Ativa (Sem USB)';
        if (dashTxt) dashTxt.textContent = 'Transmitindo via Simulador Virtual';
        if (calDot) calDot.classList.add('simulated');
        if (dashDot) dashDot.classList.add('simulated');
      }

      atualizarTodosOsModulos({ ldr, max, pct, leds });
    }

    function registrarLeituraSimulada() {
      registrarLeituraManual('Simulação LDR (' + estadoAtual.pct + '%)');
    }

    function definirPresetLDR(valorPct) {
      const slider = document.getElementById('sim-ldr-slider');
      if (slider) slider.value = valorPct;
      simularIluminacaoLDR(valorPct);
      registrarLeituraSimulada();
    }

    function toggleWidgetSimulador() {
      const widget = document.getElementById('ldr-virtual-widget');
      const icon = document.getElementById('ldr-widget-toggle-icon');
      if (!widget) return;
      const minimizado = widget.classList.toggle('minimized');
      if (icon) icon.textContent = minimizado ? '+' : '−';
    }

    function destacarControleVirtual() {
      const widget = document.getElementById('ldr-virtual-widget');
      const icon = document.getElementById('ldr-widget-toggle-icon');
      if (!widget) return;

      if (widget.classList.contains('minimized')) {
        widget.classList.remove('minimized');
        if (icon) icon.textContent = '−';
      }

      widget.classList.remove('pulse-highlight');
      void widget.offsetWidth; // força reflow para reiniciar animação
      widget.classList.add('pulse-highlight');

      const slider = document.getElementById('sim-ldr-slider');
      if (slider) slider.focus();
    }

    // ========================================================================
    // 3. SINCRONIZAÇÃO HARMONIOSA DOS 3 MÓDULOS (CALIBRADOR + GAME + DASHBOARD)
    // ========================================================================
    function atualizarTodosOsModulos(d) {
      if (!d || d.ldr === undefined) return;

      const ldr = Number(d.ldr);
      const max = Number(d.max ?? 240);
      const pct = Number(d.pct ?? Math.min(100, Math.max(0, Math.round((ldr / max) * 100))));
      const leds = Number(d.leds ?? calcularLedsPorPorcentagem(pct));

      let condicao = 'Escuro';
      if (pct >= 70) {
        condicao = 'Muito Claro';
      } else if (pct >= 30) {
        condicao = 'Luz Ambiente';
      }

      estadoAtual = { ldr, max, pct, leds, condicao };

      // ----------------------------------------------------------------------
      // ATUALIZA CONTROLE FIXO DE SIMULAÇÃO VIRTUAL
      // ----------------------------------------------------------------------
      const simSlider = document.getElementById('sim-ldr-slider');
      const simPct = document.getElementById('sim-ldr-pct');
      const simAdc = document.getElementById('sim-ldr-adc');
      const simMax = document.getElementById('sim-ldr-max');
      const simLeds = document.getElementById('sim-ldr-leds');

      if (simSlider && document.activeElement !== simSlider) {
        simSlider.value = pct;
      }
      if (simPct) simPct.textContent = pct + '%';
      if (simAdc) simAdc.textContent = ldr;
      if (simMax) simMax.textContent = max;
      if (simLeds) simLeds.textContent = leds + '/4';

      // ----------------------------------------------------------------------
      // ATUALIZA DIV 2: CALIBRADOR (projeto_ldr_mega.html)
      // ----------------------------------------------------------------------
      document.getElementById('cal-ldr').textContent = ldr;
      document.getElementById('cal-max').textContent = max;
      document.getElementById('cal-pct').textContent = pct + '%';
      document.getElementById('cal-bar').style.width = pct + '%';
      document.getElementById('cal-leds-count').textContent = leds + ' / 4 acesos';

      for (let i = 1; i <= 4; i++) {
        const el = document.getElementById('led' + i);
        if (el) el.classList.toggle('on', i <= leds);
      }

      // ----------------------------------------------------------------------
      // ATUALIZA DIV 1: GAME MODE (game.html)
      // ----------------------------------------------------------------------
      const gameProgressBar = document.getElementById('game-progress-bar');

      document.getElementById('game-val-adc').textContent = ldr;
      document.getElementById('game-val-max').textContent = max;
      document.getElementById('game-val-porcentagem').textContent = pct + '%';
      gameProgressBar.style.width = pct + '%';

      // Cor da barra de progresso do Game alinhada ao Design System
      gameProgressBar.style.background = 'var(--progress-fill)';

      // ----------------------------------------------------------------------
      // ATUALIZA DIV 3: DASHBOARD & TEMA DA PÁGINA (index.html)
      // ----------------------------------------------------------------------
      document.getElementById('dash-val-adc').textContent = ldr;
      document.getElementById('dash-val-max').textContent = max;
      document.getElementById('dash-val-porcentagem').textContent = pct;
      document.getElementById('dash-val-condicao').textContent = condicao;
      document.getElementById('dash-progress-bar').style.width = pct + '%';

      // Transição Dia/Claro e Noite/Escuro sincronizada
      aplicarTema(pct >= LIMIAR_DIA_TEMA);

      // Registro automático no Histórico a cada 5 minutos (e na 1ª leitura)
      const agoraTimestamp = Date.now();
      if (agoraTimestamp - ultimoRegistroHistorico >= INTERVALO_HISTORICO) {
        adicionarAoHistorico(ldr, max, pct, leds, condicao);
        ultimoRegistroHistorico = agoraTimestamp;
      }
    }

    function aplicarTema(modoClaro) {
      const gameViewport = document.getElementById('game-viewport');
      const stationWork = document.getElementById('station-work');
      const stationSleep = document.getElementById('station-sleep');
      const gameStatusText = document.getElementById('game-status-text');
      const themeIcon = document.getElementById('dash-theme-icon');
      const themeText = document.getElementById('dash-theme-text');

      if (modoClaro) {
        document.body.classList.add('theme-light');
        if (themeIcon) themeIcon.textContent = '☀️';
        if (themeText) themeText.textContent = 'Tema: Claro';

        gameViewport.classList.remove('night');
        gameViewport.classList.add('day');
        stationWork.classList.remove('hidden');
        stationSleep.classList.add('hidden');
        gameStatusText.textContent = 'WORKING...';
      } else {
        document.body.classList.remove('theme-light');
        if (themeIcon) themeIcon.textContent = '🌙';
        if (themeText) themeText.textContent = 'Tema: Escuro';

        gameViewport.classList.remove('day');
        gameViewport.classList.add('night');
        stationWork.classList.add('hidden');
        stationSleep.classList.remove('hidden');
        gameStatusText.textContent = 'SLEEPING...';
      }
    }

    function alternarTemaManual() {
      const estaClaro = document.body.classList.contains('theme-light');
      aplicarTema(!estaClaro);
    }

    // ========================================================================
    // 4. TABELA DE HISTÓRICO COMPARTILHADA
    // ========================================================================
    function adicionarAoHistorico(ldr, max, pct, leds, condicao) {
      const logTabela = document.getElementById('dash-log-tabela');
      const agora = new Date().toLocaleTimeString('pt-BR');

      if (logTabela.querySelector('.text-center')) {
        logTabela.innerHTML = '';
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${agora}</td>
        <td>${ldr}</td>
        <td>${max}</td>
        <td>${pct}%</td>
        <td>${leds}/4</td>
        <td>${condicao}</td>
      `;

      logTabela.insertBefore(tr, logTabela.firstChild);

      while (logTabela.children.length > 15) {
        logTabela.removeChild(logTabela.lastChild);
      }
    }

    function registrarLeituraManual(rotuloExtra) {
      const status = rotuloExtra ? `${estadoAtual.condicao} - ${rotuloExtra}` : estadoAtual.condicao;
      adicionarAoHistorico(
        estadoAtual.ldr,
        estadoAtual.max,
        estadoAtual.pct,
        estadoAtual.leds,
        status
      );
    }

    function limparHistorico() {
      const logTabela = document.getElementById('dash-log-tabela');
      logTabela.innerHTML = `<tr><td colspan="6" class="text-center">Histórico limpo.</td></tr>`;
    }

    // Desconexão automática caso o cabo USB seja removido fisicamente
    if ('serial' in navigator) {
      navigator.serial.addEventListener('disconnect', (event) => {
        if (event.target === port) {
          desconectarSerial();
        }
      });
    }

    // Inicializa o dashboard com o estado inicial da simulação virtual ao carregar a página
    window.addEventListener('DOMContentLoaded', () => {
      simularIluminacaoLDR(0);
    });
