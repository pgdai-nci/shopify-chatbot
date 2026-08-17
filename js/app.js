(function () {
  'use strict';

  /* ─── Configuration ─── */
  const WORKER_URL = 'https://shopify-chatbot-worker.YOUR_SUBDOMAIN.workers.dev/';

  const SYSTEM_INSTRUCTION = `You are ShopiBot, a friendly and helpful shopping assistant for Shopi, an online store.

Your capabilities:
- Help customers find products by describing what they need
- Answer questions about products (sizes, materials, features)
- Explain the order tracking process
- Guide customers through returns and exchanges
- Provide shipping information and policies

Your personality:
- Friendly and approachable, but professional
- Concise — keep responses under 3 sentences unless more detail is needed
- Use emojis sparingly (1-2 per message max)
- Always try to be helpful, even if you don't have exact information

Rules:
- If you don't know something specific (exact price, exact stock), say "I'd recommend checking the product page for the latest details" rather than making something up
- For order-specific questions (tracking, status), explain that you'll need their order number
- Never ask for personal information like credit card numbers, passwords, or full addresses
- If a question is clearly outside your scope, suggest contacting support directly

You are in Phase 1 — you don't have access to real product data or order systems yet. Be honest about your current capabilities while being as helpful as possible.`;

  const MAX_HISTORY_TURNS = 10;

  const STORAGE_KEYS = {
    messages: 'shopibot_messages',
    config: 'shopibot_config'
  };

  const WELCOME_TEXT = `Hey! 👋 I'm ShopiBot, your assistant here at Shopi. Ask me anything \u2014 I can help you find the right product, check on an order, or sort out a return.`;

  const WELCOME_REPLIES = [
    { label: '\uD83D\uDCE6 Track my order', message: 'Where is my order?' },
    { label: '\uD83D\uDECD\uFE0F Help me find something', message: 'Help me find a product' },
    { label: '\u21A9\uFE0F Start a return', message: 'I need to return something' },
    { label: '\uD83D\uDCAC Ask a question', message: 'I have a question' }
  ];

  /* ─── State ─── */
  const state = {
    isOpen: false,
    messages: [],
    isLoading: false,
    lastSentMessage: null,
    quickRepliesDisabled: false,
    greetingShown: false
  };

  /* ─── DOM References ─── */
  let els = {};

  function cacheDom() {
    els = {
      launcher: document.getElementById('shopibot-launcher'),
      widget: document.getElementById('shopibot-widget'),
      messages: document.getElementById('shopibot-messages'),
      input: document.getElementById('shopibot-input'),
      sendBtn: document.getElementById('shopibot-send'),
      headerMinimize: document.querySelector('.shopibot-header-minimize'),
      headerBack: document.querySelector('.shopibot-header-back')
    };
  }

  /* ─── localStorage ─── */
  function loadMessages() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.messages);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveMessages() {
    try {
      localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(state.messages));
    } catch (e) {
      /* quota exceeded — silent fail */
    }
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.config);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveConfig(cfg) {
    try {
      localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(cfg));
    } catch (e) {
      /* silent fail */
    }
  }

  /* ─── Utility ─── */
  function msgId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function formatText(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  /* ─── Rendering ─── */
  function renderMessage(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'shopibot-message shopibot-message-' + msg.role;
    wrapper.dataset.id = msg.id;

    if (msg.role === 'assistant' && !msg.isError) {
      const av = document.createElement('div');
      av.className = 'shopibot-avatar-small';
      av.innerHTML = '<div class="shopibot-avatar-circle-sm">S</div>';
      wrapper.appendChild(av);
    }

    if (msg.isError) {
      const av = document.createElement('div');
      av.className = 'shopibot-avatar-small';
      av.innerHTML = '<div class="shopibot-avatar-circle-sm">S</div>';
      wrapper.appendChild(av);

      const bubble = document.createElement('div');
      bubble.className = 'shopibot-bubble shopibot-bubble-error';
      bubble.innerHTML = '<p>' + formatText(msg.text) + '</p>';

      const retryBtn = document.createElement('button');
      retryBtn.className = 'shopibot-retry';
      retryBtn.setAttribute('aria-label', 'Retry sending message');
      retryBtn.textContent = '↻ Try again';
      retryBtn.addEventListener('click', retryMessage);
      bubble.appendChild(retryBtn);

      wrapper.appendChild(bubble);
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'shopibot-bubble shopibot-bubble-' + msg.role;
      bubble.innerHTML = '<p>' + formatText(msg.text) + '</p>';
      wrapper.appendChild(bubble);
    }

    if (msg.quickReplies && msg.quickReplies.length > 0) {
      const qr = document.createElement('div');
      qr.className = 'shopibot-quick-replies';
      qr.setAttribute('role', 'group');
      qr.setAttribute('aria-label', 'Quick replies');
      msg.quickReplies.forEach(function (item) {
        const btn = document.createElement('button');
        btn.className = 'shopibot-quick-reply';
        btn.dataset.message = item.message;
        btn.textContent = item.label;
        btn.addEventListener('click', function () {
          disableQuickReplies(qr);
          sendMessage(item.message);
        });
        qr.appendChild(btn);
      });
      wrapper.appendChild(qr);
    }

    els.messages.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
  }

  function renderAllMessages() {
    els.messages.innerHTML = '';
    state.messages.forEach(function (msg) {
      renderMessage(msg);
    });
    if (state.messages.length === 0 && !state.greetingShown) {
      showWelcome();
    }
  }

  function showWelcome() {
    state.greetingShown = true;
    var welcomeMsg = {
      id: msgId(),
      role: 'assistant',
      text: WELCOME_TEXT,
      timestamp: Date.now(),
      quickReplies: WELCOME_REPLIES,
      isError: false
    };
    state.messages.push(welcomeMsg);
    renderMessage(welcomeMsg);
    saveMessages();
  }

  function showTyping() {
    var el = document.createElement('div');
    el.className = 'shopibot-message shopibot-message-assistant shopibot-typing';
    el.id = 'shopibot-typing';
    el.innerHTML =
      '<div class="shopibot-avatar-small"><div class="shopibot-avatar-circle-sm">S</div></div>' +
      '<div class="shopibot-typing-dots"><span></span><span></span><span></span></div>';
    els.messages.appendChild(el);
    scrollToBottom();
  }

  function hideTyping() {
    var el = document.getElementById('shopibot-typing');
    if (el) el.remove();
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  /* ─── Typewriter ─── */
  function typewrite(text, bubble, callback) {
    var p = bubble.querySelector('p');
    if (!p) return callback && callback();
    var i = 0;
    p.textContent = '';
    function tick() {
      if (i < text.length) {
        p.textContent += text.charAt(i);
        i++;
        scrollToBottom();
        setTimeout(tick, 20);
      } else {
        callback && callback();
      }
    }
    tick();
  }

  /* ─── Quick Reply Handling ─── */
  function disableQuickReplies(container) {
    if (container) {
      container.classList.add('is-disabled');
    }
    state.quickRepliesDisabled = true;
  }

  /* ─── API ─── */
  function buildContentsForAPI(messages) {
    var recent = messages
      .filter(function (m) { return !m.isError; })
      .slice(-MAX_HISTORY_TURNS);
    return recent.map(function (m) {
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.text }]
      };
    });
  }

  async function callWorkerAPI(messages) {
    var response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: buildContentsForAPI(messages),
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
      })
    });

    if (!response.ok) {
      var errorData = null;
      try { errorData = await response.json(); } catch (e) { /* ignore */ }
      throw {
        type: 'api',
        status: response.status,
        message: errorData && errorData.error ? errorData.error.message : 'Unknown error'
      };
    }

    var data = await response.json();

    if (!data.candidates || data.candidates.length === 0) {
      throw { type: 'empty', message: 'No response generated' };
    }

    var text = data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!text) {
      throw { type: 'empty', message: 'Empty response text' };
    }

    return text;
  }

  /* ─── Error Messages ─── */
  function getErrorMessage(error) {
    if (!error) return 'Sorry, something went wrong. Please try again.';
    if (error.type === 'network') return 'Connection lost. Please check your internet and try again.';
    if (error.type === 'api' && error.status === 429) return "I'm getting a lot of questions right now. Please try again in a moment.";
    if (error.type === 'api' && error.status >= 500) return 'Sorry, something went wrong on our end.';
    if (error.type === 'empty') return "I didn't get a response. Could you try rephrasing?";
    return 'Sorry, something went wrong. Please try again.';
  }

  /* ─── Send / Receive ─── */
  async function sendMessage(text) {
    if (!text || state.isLoading) return;

    var userMsg = {
      id: msgId(),
      role: 'user',
      text: text,
      timestamp: Date.now(),
      isError: false
    };

    state.messages.push(userMsg);
    renderMessage(userMsg);
    saveMessages();

    state.lastSentMessage = text;
    state.isLoading = true;
    els.input.value = '';
    autoResize();
    updateSendButton();
    showTyping();

    try {
      var reply = await callWorkerAPI(state.messages);
      hideTyping();

      var assistantMsg = {
        id: msgId(),
        role: 'assistant',
        text: reply,
        timestamp: Date.now(),
        isError: false
      };

      state.messages.push(assistantMsg);
      saveMessages();

      var wrapper = renderMessage(assistantMsg);
      var bubble = wrapper.querySelector('.shopibot-bubble-assistant');
      if (bubble) {
        typewrite(reply, bubble);
      }

    } catch (error) {
      hideTyping();
      var errMsg = {
        id: msgId(),
        role: 'assistant',
        text: getErrorMessage(error),
        timestamp: Date.now(),
        isError: true
      };
      state.messages.push(errMsg);
      renderMessage(errMsg);
      saveMessages();
    } finally {
      state.isLoading = false;
    }
  }

  async function retryMessage() {
    if (state.isLoading || !state.lastSentMessage) return;
    /* remove last error message from DOM and array */
    var lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.isError) {
      state.messages.pop();
      var el = document.querySelector('[data-id="' + lastMsg.id + '"]');
      if (el) el.remove();
      saveMessages();
    }
    await sendMessage(state.lastSentMessage);
  }

  /* ─── Toggle Chat ─── */
  function openChat() {
    state.isOpen = true;
    els.widget.removeAttribute('hidden');
    els.widget.classList.remove('shopibot-animating-exit');
    els.widget.classList.add('shopibot-animating-enter');
    els.launcher.classList.add('is-open');
    els.launcher.setAttribute('aria-label', 'Close chat');

    /* mobile back arrow */
    var isMobile = window.innerWidth < 768;
    if (isMobile) {
      els.headerBack.removeAttribute('hidden');
      els.headerMinimize.setAttribute('hidden', '');
    } else {
      els.headerBack.setAttribute('hidden', '');
      els.headerMinimize.removeAttribute('hidden');
    }

    setTimeout(function () {
      els.input.focus();
    }, 210);

    if (state.messages.length === 0) {
      showWelcome();
    }
  }

  function closeChat() {
    state.isOpen = false;
    els.widget.classList.remove('shopibot-animating-enter');
    els.widget.classList.add('shopibot-animating-exit');
    els.launcher.classList.remove('is-open');
    els.launcher.setAttribute('aria-label', 'Open chat');

    setTimeout(function () {
      els.widget.setAttribute('hidden', '');
      els.widget.classList.remove('shopibot-animating-exit');
      els.launcher.focus();
    }, 200);
  }

  function toggleChat() {
    if (state.isOpen) {
      closeChat();
    } else {
      openChat();
    }
  }

  /* ─── Input Handling ─── */
  function autoResize() {
    var el = els.input;
    el.style.height = 'auto';
    var newH = Math.min(el.scrollHeight, 120);
    el.style.height = newH + 'px';
  }

  function updateSendButton() {
    els.sendBtn.disabled = !els.input.value.trim();
  }

  /* ─── Events ─── */
  function bindEvents() {
    els.launcher.addEventListener('click', toggleChat);
    els.headerMinimize.addEventListener('click', closeChat);
    els.headerBack.addEventListener('click', closeChat);

    els.input.addEventListener('input', function () {
      autoResize();
      updateSendButton();
    });

    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (els.input.value.trim()) {
          sendMessage(els.input.value.trim());
        }
      }
    });

    els.sendBtn.addEventListener('click', function () {
      if (els.input.value.trim()) {
        sendMessage(els.input.value.trim());
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.isOpen) {
        closeChat();
      }
    });

    window.addEventListener('resize', function () {
      if (!state.isOpen) return;
      var isMobile = window.innerWidth < 768;
      if (isMobile) {
        els.headerBack.removeAttribute('hidden');
        els.headerMinimize.setAttribute('hidden', '');
      } else {
        els.headerBack.setAttribute('hidden', '');
        els.headerMinimize.removeAttribute('hidden');
      }
    });
  }

  /* ─── Init ─── */
  function init() {
    cacheDom();
    state.messages = loadMessages();
    var cfg = loadConfig();
    state.greetingShown = !!cfg.greetingShown;
    bindEvents();
    renderAllMessages();

    /* pulse animation after 3 seconds for first visit */
    if (state.messages.length === 0) {
      setTimeout(function () {
        els.launcher.classList.add('is-pulsing');
        setTimeout(function () {
          els.launcher.classList.remove('is-pulsing');
        }, 700);
      }, 3000);
    }

    saveConfig({ greetingShown: state.greetingShown });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
