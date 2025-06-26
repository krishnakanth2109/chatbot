document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const chatBox = document.getElementById('chatBox');
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendButton');
    const stopButton = document.getElementById('stopButton');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const prefsToggle = document.getElementById('prefsToggle');
    const prefsPanel = document.getElementById('preferencesPanel');
    const responseLength = document.getElementById('responseLength');
    const formality = document.getElementById('formality');
    const tone = document.getElementById('tone');
    const resetConversation = document.getElementById('resetConversation');
    const creativitySlider = document.getElementById('creativity');

    // State variables
    let controller = null;
    let conversationId = null;
    let isPreferencesOpen = false;
    let isProcessing = false;

    // Initialize
    init();

    function init() {
        loadPreferences();
        setupEventListeners();
        userInput.focus();
    }

    function loadPreferences() {
        const savedPrefs = localStorage.getItem('chatPreferences');
        if (savedPrefs) {
            try {
                const prefs = JSON.parse(savedPrefs);
                if (prefs.responseLength) responseLength.value = prefs.responseLength;
                if (prefs.formality) formality.value = prefs.formality;
                if (prefs.tone) tone.value = prefs.tone;
                if (prefs.creativity) creativitySlider.value = prefs.creativity;
            } catch (e) {
                console.error('Failed to load preferences:', e);
            }
        }
    }

    function setupEventListeners() {
        sendButton.addEventListener('click', sendMessage);
        stopButton.addEventListener('click', stopGeneration);
        userInput.addEventListener('keydown', handleKeyDown);
        userInput.addEventListener('input', adjustTextareaHeight);
        prefsToggle.addEventListener('click', togglePreferences);
        responseLength.addEventListener('change', savePreferences);
        formality.addEventListener('change', savePreferences);
        tone.addEventListener('change', savePreferences);
        creativitySlider.addEventListener('input', savePreferences);
        resetConversation.addEventListener('click', resetConversationHandler);
        document.addEventListener('click', handleOutsideClick);
    }

    function addMessage(role, content) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}-message`;
        
        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        
        try {
            messageContent.innerHTML = marked.parse(content || '');
            messageContent.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
        } catch (e) {
            console.error('Markdown parsing error:', e);
            messageContent.textContent = content;
        }
        
        messageDiv.appendChild(messageContent);
        chatBox.appendChild(messageDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
        return messageContent;
    }

    function showError(error) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'message error-message';
        errorDiv.innerHTML = marked.parse(`**Error:** ${error.message || 'An unknown error occurred.'}`);
        chatBox.appendChild(errorDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    function toggleControls(processing) {
        isProcessing = processing;
        userInput.disabled = processing;
        sendButton.style.display = processing ? 'none' : 'flex';
        stopButton.style.display = processing ? 'flex' : 'none';
        loadingIndicator.style.display = processing ? 'flex' : 'none';
    }

    function savePreferences() {
        const preferences = {
            responseLength: responseLength.value,
            formality: formality.value,
            tone: tone.value,
            creativity: parseFloat(creativitySlider.value)
        };
        localStorage.setItem('chatPreferences', JSON.stringify(preferences));
        
        // Update server preferences
        fetch('/api/preferences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(preferences)
        }).catch(console.error);
    }

    async function sendMessage() {
        const message = userInput.value.trim();
        if (!message || isProcessing) return;

        toggleControls(true);
        addMessage('user', message);
        userInput.value = '';
        adjustTextareaHeight();

        controller = new AbortController();
        
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-Conversation-ID': conversationId || ''
                },
                body: JSON.stringify({ 
                    message,
                    preferences: {
                        responseLength: responseLength.value,
                        formality: formality.value,
                        tone: tone.value,
                        creativity: parseFloat(creativitySlider.value)
                    }
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Request failed');
            }

            if (!conversationId) {
                conversationId = response.headers.get('X-Conversation-ID');
            }

            const data = await response.json();
            addMessage('assistant', data.response);

        } catch (error) {
            if (error.name !== 'AbortError') {
                showError(error);
            } else {
                addMessage('assistant', '_Generation stopped by user_');
            }
        } finally {
            toggleControls(false);
            controller = null;
        }
    }

    function stopGeneration() {
        if (controller) {
            controller.abort();
        }
    }

    function handleKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey && !isProcessing) {
            e.preventDefault();
            sendMessage();
        }
    }

    function adjustTextareaHeight() {
        userInput.style.height = 'auto';
        userInput.style.height = `${Math.min(userInput.scrollHeight, 150)}px`;
    }

    function togglePreferences() {
        isPreferencesOpen = !isPreferencesOpen;
        prefsPanel.classList.toggle('show', isPreferencesOpen);
    }

    function handleOutsideClick(e) {
        if (isPreferencesOpen && !prefsPanel.contains(e.target) && e.target !== prefsToggle) {
            isPreferencesOpen = false;
            prefsPanel.classList.remove('show');
        }
    }

    async function resetConversationHandler() {
        try {
            const response = await fetch('/api/reset', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Conversation-ID': conversationId || ''
                }
            });

            if (!response.ok) throw new Error('Failed to reset conversation');

            conversationId = null;
            
            const systemMessage = document.createElement('div');
            systemMessage.className = 'system-message';
            systemMessage.textContent = 'Conversation reset. Starting new chat.';
            chatBox.appendChild(systemMessage);
            chatBox.scrollTop = chatBox.scrollHeight;

        } catch (error) {
            showError(error);
        }
    }
});