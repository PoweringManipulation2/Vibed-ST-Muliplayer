/**
 * UI layer: the settings drawer, the character-list cloud badges and the
 * extension-sync dialog.
 *
 * The character list is re-rendered by SillyTavern on a lot of triggers
 * (filters, tags, paging, favourites). Rather than trying to hook every one,
 * a throttled MutationObserver re-applies the badges whenever the list DOM
 * changes, which is cheap and cannot get out of sync.
 */

import { applyPlan, summarisePlan } from './parity.js';
import { isRemoteCard, remoteCardId } from './cards.js';

const CLOUD_CLASS = 'stmp-cloud';
const REMOTE_CLASS = 'stmp-remote';
const OFFLINE_CLASS = 'stmp-offline';

export class MultiplayerUI {
    constructor({ session, deps }) {
        this.session = session;
        this.deps = deps;
        this.observer = null;
        this._decorateScheduled = false;
    }

    // -- settings panel -----------------------------------------------------

    async mount() {
        const context = this.deps.getContext();
        const template = await context.renderExtensionTemplateAsync(this.deps.extensionFolder, 'settings');
        document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', template);

        this.#bindControls();
        this.#bindCharacterList();
        this.#bindSessionEvents();
        this.refresh();
    }

    $(selector) {
        return document.querySelector(selector);
    }

    #bindControls() {
        const settings = this.deps.settings();
        const save = this.deps.save;

        const bindValue = (selector, key, parse = value => value) => {
            const element = this.$(selector);
            if (!element) return;
            const isCheckbox = element.type === 'checkbox';
            if (isCheckbox) element.checked = Boolean(settings[key]);
            else element.value = settings[key] ?? '';
            element.addEventListener('change', () => {
                settings[key] = isCheckbox ? element.checked : parse(element.value);
                save();
            });
        };

        bindValue('#stmp_port', 'port', value => Math.min(65535, Math.max(1024, Number(value) || 8899)));
        bindValue('#stmp_bind_lan', 'bindLan');
        bindValue('#stmp_room_name', 'roomName');
        bindValue('#stmp_max_peers', 'maxPeers', value => Math.min(8, Math.max(2, Number(value) || 4)));
        bindValue('#stmp_require_parity', 'requireParity');
        bindValue('#stmp_parity_strictness', 'parityStrictness');
        bindValue('#stmp_auto_reconnect', 'autoReconnect');

        this.$('#stmp_host_start')?.addEventListener('click', () => void this.#hostStart());
        this.$('#stmp_host_stop')?.addEventListener('click', () => void this.#hostStop());
        this.$('#stmp_rotate')?.addEventListener('click', () => void this.#rotate());
        this.$('#stmp_copy_code')?.addEventListener('click', () => void this.#copyCode());
        this.$('#stmp_join')?.addEventListener('click', () => void this.#join());
        this.$('#stmp_leave')?.addEventListener('click', () => void this.session.leave());
        this.$('#stmp_sync')?.addEventListener('click', () => void this.openSyncDialog());
        this.$('#stmp_pick_cards')?.addEventListener('click', () => void this.openCardPicker());

        this.$('#stmp_code_input')?.addEventListener('keydown', event => {
            if (event.key === 'Enter') void this.#join();
        });
    }

    #bindSessionEvents() {
        for (const type of ['status', 'roster', 'code', 'cards', 'cards-materialised', 'card-hydrated']) {
            this.session.addEventListener(type, () => this.refresh());
        }
        this.session.addEventListener('log', event => this.#log(event.detail));
        this.session.addEventListener('parity-mismatch', event => {
            this.refresh();
            void this.openSyncDialog(event.detail);
        });
    }

    // -- actions ------------------------------------------------------------

    async #hostStart() {
        const { toastr } = this.deps;
        try {
            this.#setBusy('#stmp_host_start', true);
            await this.session.startHosting();
            toastr.success('Room is open. Share the connection code.', 'Multiplayer');
        } catch (error) {
            toastr.error(error.message ?? String(error), 'Could not start hosting');
        } finally {
            this.#setBusy('#stmp_host_start', false);
            this.refresh();
        }
    }

    async #hostStop() {
        await this.session.stopHosting();
        this.deps.toastr.info('Room closed.', 'Multiplayer');
        this.refresh();
    }

    async #rotate() {
        const context = this.deps.getContext();
        const confirmed = await context.callGenericPopup(
            'Rotating the code disconnects everyone currently in the room and invalidates the old code. Continue?',
            context.POPUP_TYPE.CONFIRM,
        );
        if (!confirmed) return;
        try {
            await this.session.rotateCode();
            this.deps.toastr.success('New code generated.', 'Multiplayer');
        } catch (error) {
            this.deps.toastr.error(error.message, 'Rotation failed');
        }
        this.refresh();
    }

    async #copyCode() {
        if (!this.session.code) return;
        try {
            await navigator.clipboard.writeText(this.session.code);
            this.deps.toastr.success('Connection code copied.', 'Multiplayer');
        } catch {
            this.deps.toastr.info('Copy the code from the field above.', 'Multiplayer');
        }
    }

    async #join() {
        const code = this.$('#stmp_code_input')?.value?.trim();
        if (!code) return this.deps.toastr.warning('Paste a connection code first.', 'Multiplayer');
        try {
            this.#setBusy('#stmp_join', true);
            await this.session.join(code);
        } catch (error) {
            this.deps.toastr.error(error.message ?? String(error), 'Could not join');
        } finally {
            this.#setBusy('#stmp_join', false);
            this.refresh();
        }
    }

    // -- card picker (host) -------------------------------------------------

    async openCardPicker() {
        const context = this.deps.getContext();
        const settings = this.deps.settings();
        const shared = new Set(settings.sharedCards ?? []);

        const rows = (context.characters ?? [])
            .filter(character => !isRemoteCard(character))
            .map(character => {
                const checked = shared.has(character.avatar) ? 'checked' : '';
                const name = escapeHtml(character.name);
                return `<label class="stmp-pick-row">
                    <input type="checkbox" value="${escapeHtml(character.avatar)}" ${checked}>
                    <img src="${context.getThumbnailUrl('avatar', character.avatar)}" alt="">
                    <span>${name}</span>
                </label>`;
            }).join('');

        const html = `<div class="stmp-picker">
            <h3>Share characters with the room</h3>
            <p class="stmp-muted">Everyone in the room sees these as cloud cards. The card text itself is only sent while they are connected — it is never written to their disk.</p>
            <div class="stmp-pick-list">${rows || '<em>No local characters yet.</em>'}</div>
        </div>`;

        const result = await context.callGenericPopup(html, context.POPUP_TYPE.CONFIRM, '', {
            okButton: 'Share selected', cancelButton: 'Cancel', wide: true,
        });
        if (!result) return;

        const selected = [...document.querySelectorAll('.stmp-pick-list input:checked')].map(input => input.value);
        settings.sharedCards = selected;
        this.deps.save();

        if (this.session.connected) await this.session.publishCards();
        this.deps.toastr.success(`Sharing ${selected.length} character${selected.length === 1 ? '' : 's'}.`, 'Multiplayer');
        this.refresh();
    }

    // -- extension sync dialog ---------------------------------------------

    async openSyncDialog(detail = null) {
        const context = this.deps.getContext();
        const diff = detail?.diff ?? this.session.pendingDiff;

        if (!diff) {
            this.deps.toastr.info('Nothing to sync — your extensions already match, or you are not connected yet.', 'Multiplayer');
            return;
        }

        const section = (title, items, render) => (items?.length
            ? `<div class="stmp-diff-group"><b>${title}</b><ul>${items.map(render).join('')}</ul></div>`
            : '');

        const html = `<div class="stmp-sync">
            <h3>Extension mismatch</h3>
            <p class="stmp-muted">The host is running a different set of extensions. Syncing makes your install match theirs.</p>
            ${section('Missing on your install', diff.missing, item => `<li>${escapeHtml(item.displayName || item.id)} <code>${escapeHtml(item.version)}</code></li>`)}
            ${section('Different version', diff.mismatched, item => `<li>${escapeHtml(item.displayName || item.id)} <code>${escapeHtml(item.clientVersion)}</code> → <code>${escapeHtml(item.version)}</code></li>`)}
            ${section('Extra on your install', diff.extra, item => `<li>${escapeHtml(item.displayName || item.id)}</li>`)}
            <label class="stmp-inline"><input type="checkbox" id="stmp_remove_extras"> Delete extra extensions instead of just disabling them</label>
            <div id="stmp_sync_progress" class="stmp-progress" hidden></div>
        </div>`;

        const confirmed = await context.callGenericPopup(html, context.POPUP_TYPE.CONFIRM, '', {
            okButton: 'Sync extensions', cancelButton: 'Not now', wide: true,
        });
        if (!confirmed) return;

        const removeExtras = Boolean(document.querySelector('#stmp_remove_extras')?.checked);
        const plan = this.session.syncPlan({ removeExtras });
        if (!plan.length) {
            this.deps.toastr.info('Nothing to change.', 'Multiplayer');
            return;
        }

        this.deps.toastr.info(`Starting sync: ${summarisePlan(plan)}.`, 'Multiplayer');

        const results = await applyPlan(plan, this.deps.extensionApi, progress => {
            const label = `${progress.index + 1}/${progress.total} ${progress.step.action} ${progress.step.label}`;
            this.#log({ level: progress.status === 'failed' ? 'error' : 'info', message: label });
        });

        const failed = results.filter(result => result.status === 'failed');
        const manual = results.filter(result => result.status === 'skipped');

        if (failed.length) {
            this.deps.toastr.error(`${failed.length} step(s) failed. See the Multiplayer log.`, 'Sync incomplete');
        }
        if (manual.length) {
            this.deps.toastr.warning(`${manual.length} extension(s) must be installed by hand.`, 'Sync incomplete');
        }
        if (!failed.length && !manual.length) {
            const reload = await context.callGenericPopup(
                'Sync finished. SillyTavern needs to reload for the changes to take effect. Reload now?',
                context.POPUP_TYPE.CONFIRM,
            );
            if (reload) location.reload();
        }
    }

    // -- character list decoration -----------------------------------------

    #bindCharacterList() {
        const context = this.deps.getContext();
        const list = document.querySelector('#rm_print_characters_block');
        if (!list) return;

        this.observer = new MutationObserver(() => this.#scheduleDecorate());
        this.observer.observe(list, { childList: true, subtree: false });

        context.eventSource.on(context.eventTypes.CHARACTER_PAGE_LOADED, () => this.#scheduleDecorate());
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => this.#onChatChanged());

        // Capture phase so an unusable card never reaches SillyTavern's own
        // click handler and half-opens.
        list.addEventListener('click', event => this.#gateClick(event), true);

        this.#scheduleDecorate();
    }

    #scheduleDecorate() {
        if (this._decorateScheduled) return;
        this._decorateScheduled = true;
        requestAnimationFrame(() => {
            this._decorateScheduled = false;
            try {
                this.decorateCharacterList();
            } catch (error) {
                console.warn('[Multiplayer] Could not decorate the character list', error);
            }
        });
    }

    decorateCharacterList() {
        const context = this.deps.getContext();
        const online = this.session.connected;

        for (const block of document.querySelectorAll('#rm_print_characters_block .character_select')) {
            const chid = block.getAttribute('data-chid');
            const character = context.characters?.[chid];

            if (!character || !isRemoteCard(character)) {
                block.classList.remove(REMOTE_CLASS, OFFLINE_CLASS);
                block.querySelector(`.${CLOUD_CLASS}`)?.remove();
                continue;
            }

            block.classList.add(REMOTE_CLASS);
            block.classList.toggle(OFFLINE_CLASS, !online);

            let badge = block.querySelector(`.${CLOUD_CLASS}`);
            if (!badge) {
                badge = document.createElement('i');
                badge.className = `${CLOUD_CLASS} fa-solid fa-cloud`;
                block.querySelector('.avatar')?.append(badge);
            }
            const host = character.data?.extensions?.st_multiplayer?.hostName ?? 'another player';
            badge.title = online
                ? `Hosted by ${host} — available while you are connected`
                : `Hosted by ${host} — connect to the Multiplayer session to use this character`;
        }
    }

    /** Blocks opening a hosted card while offline; hydrates it while online. */
    #gateClick(event) {
        const block = event.target.closest?.('.character_select');
        if (!block) return;

        const context = this.deps.getContext();
        const character = context.characters?.[block.getAttribute('data-chid')];
        if (!character || !isRemoteCard(character)) return;

        if (!this.session.connected) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const host = character.data?.extensions?.st_multiplayer?.hostName ?? 'another player';
            this.deps.toastr.warning(`"${character.name}" is hosted by ${host}. Join their session to use it.`, 'Character unavailable');
            return;
        }

        const cardId = remoteCardId(character);
        if (cardId && !this.session.hydration.isHydrated(character.avatar)) {
            this.session.requestDefinition(cardId);
        }
    }

    #onChatChanged() {
        this.#scheduleDecorate();
    }

    // -- rendering ----------------------------------------------------------

    refresh() {
        const session = this.session;
        const hosting = session.role === 'host' && session.status !== 'idle';
        const joined = session.role === 'client' && session.status !== 'idle';

        const setText = (selector, text) => { const el = this.$(selector); if (el) el.textContent = text; };
        const setHidden = (selector, hidden) => { const el = this.$(selector); if (el) el.hidden = hidden; };
        const setDisabled = (selector, disabled) => { const el = this.$(selector); if (el) el.classList.toggle('disabled', disabled); };

        const labels = {
            idle: 'Not connected', starting: 'Starting relay…', connecting: 'Connecting…',
            verifying: 'Checking extensions…', connected: 'Connected', error: 'Problem',
        };
        setText('#stmp_status_text', labels[session.status] ?? session.status);
        const dot = this.$('#stmp_status_dot');
        if (dot) dot.dataset.state = session.status;

        setText('#stmp_error', session.status === 'error' ? session.lastError : '');
        setHidden('#stmp_error', session.status !== 'error');

        const codeField = this.$('#stmp_code_output');
        if (codeField) codeField.value = session.code && session.role === 'host' ? session.code : '';

        setHidden('#stmp_host_running', !hosting);
        setDisabled('#stmp_host_start', hosting || joined);
        setDisabled('#stmp_join', hosting || joined);
        setHidden('#stmp_leave', !joined);
        setHidden('#stmp_sync', !session.pendingDiff);

        const addresses = this.$('#stmp_addresses');
        if (addresses) {
            addresses.innerHTML = (session.addresses ?? [])
                .map(address => `<code>${escapeHtml(address)}</code>`).join(' ');
        }

        const roster = this.$('#stmp_roster');
        if (roster) {
            roster.innerHTML = session.peers.length
                ? session.peers.map(peer => `<li>
                        <i class="fa-solid ${peer.role === 'host' ? 'fa-crown' : 'fa-user'}"></i>
                        <span>${escapeHtml(peer.name ?? 'Player')}</span>
                        ${peer.rtt != null ? `<small>${peer.rtt}ms</small>` : ''}
                        ${session.role === 'host' && peer.role !== 'host'
                        ? `<button class="stmp-kick menu_button" data-peer="${escapeHtml(peer.id)}" title="Remove">✕</button>` : ''}
                    </li>`).join('')
                : '<li class="stmp-muted">Nobody else here yet</li>';

            for (const button of roster.querySelectorAll('.stmp-kick')) {
                button.addEventListener('click', () => void session.kick(button.dataset.peer));
            }
        }

        const cards = this.$('#stmp_cards');
        if (cards) {
            const shared = this.deps.settings().sharedCards ?? [];
            cards.textContent = session.role === 'host'
                ? `Sharing ${shared.length} character${shared.length === 1 ? '' : 's'}`
                : `${session.cardIndex.length} hosted character${session.cardIndex.length === 1 ? '' : 's'} available`;
        }

        this.#scheduleDecorate();
    }

    #log({ level, message }) {
        const log = this.$('#stmp_log');
        if (!log) return;
        const line = document.createElement('div');
        line.className = `stmp-log-line stmp-log-${level}`;
        line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
        log.prepend(line);
        while (log.childElementCount > 60) log.lastElementChild.remove();
    }

    #setBusy(selector, busy) {
        const element = this.$(selector);
        if (element) element.classList.toggle('stmp-busy', busy);
    }

    destroy() {
        this.observer?.disconnect();
        document.querySelector('#stmp_settings')?.remove();
        for (const badge of document.querySelectorAll(`.${CLOUD_CLASS}`)) badge.remove();
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[char]
    ));
}
