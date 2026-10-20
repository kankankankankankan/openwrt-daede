// SPDX-License-Identifier: Apache-2.0
'use strict';
'require baseclass';
'require fs';
'require ui';

// 2026-09-11: Keep member credentials in a private one-use request, never in argv or UCI.
const HELPER = '/usr/share/luci-app-daede/member-sync.sh';

function callHelper(action, args) {
	return fs.exec(HELPER, [action].concat(args || [])).then(function(result) {
		let body;
		try { body = JSON.parse(result.stdout || '{}'); }
		catch (e) { throw new Error('会员服务返回异常，请检查插件是否完整安装'); }
		if (!body.ok || result.code !== 0)
			throw new Error(body.error || '操作失败，请检查服务地址和路由器网络');
		return body;
	});
}

// 2026-10-16: Poll small RPCs while the router completes long cloud requests.
function invoke(action, args, progress) {
 if (!['login', 'sync', 'logout'].includes(action)) return callHelper(action, args);
 const bytes = new Uint8Array(16);
 window.crypto.getRandomValues(bytes);
 const id = Array.from(bytes, n => ('0' + n.toString(16)).slice(-2)).join('');
 const deadline = Date.now() + 300000;
 function waitResult() {
  return callHelper('result', [id]).then(function(result) {
   if (!result.pending) return result;
   if (progress && result.phase) progress(result.phase);
   if (Date.now() >= deadline) throw new Error('任务仍在处理，请稍后刷新查看结果，勿重复提交');
   return new Promise(resolve => setTimeout(resolve, 1000)).then(waitResult);
  });
 }
 return callHelper('start', [id, action].concat(args || [])).then(waitResult);
}

function getStatus() { return invoke('status'); }

function assertLocal() {
	return getStatus().then(function(state) {
		if (state.mode === 'cloud')
			throw new Error('当前使用云端配置，请先在会员配置卡片中切换到本地编辑');
	});
}

function login(values) {
	const bytes = new Uint8Array(16);
	window.crypto.getRandomValues(bytes);
	const token = Array.prototype.map.call(bytes, function(n) { return ('0' + n.toString(16)).slice(-2); }).join('');
	const file = '/tmp/daede-member-request.' + token + '.json';
	return fs.write(file, JSON.stringify(values), 384)
		.then(function() { return invoke('login', [token]); })
		.finally(function() { return fs.remove(file).catch(function() {}); });
}

function usageBytes(value) {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatBytes(value) {
	if (value === null) return '未提供';
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
	let index = 0;
	while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
	return Number(value.toFixed(2)) + ' ' + units[index];
}

function renderUsage(ctx) {
	const state = ctx.memberState || {};
	// 未登录时状态行已经显示登录状态，避免重复占用会员卡空间。
	if (!state.logged_in && !ctx.memberError && state.quota_status !== 'unavailable') return null;
	const quota = state.quota || {};
	const upload = usageBytes(quota.upload), download = usageBytes(quota.download);
	let used = usageBytes(quota.used);
	if (used === null && upload !== null && download !== null) used = usageBytes(upload + download);
	const total = usageBytes(quota.total) > 0 ? quota.total : null;
	const percent = used !== null && total > 0 ? used / total * 100 : null;
	const remaining = percent !== null ? Math.max(0, total - used) : usageBytes(quota.remaining);
	// LuCI E() can interpret string children as markup. Assign all labels as text.
	function text(tag, attrs, value) {
		const node = E(tag, attrs); node.textContent = value; return node;
	}
	let message = '';
	if (ctx.memberError || state.quota_status === 'unavailable') message = '暂时无法获取会员用量，请稍后刷新页面';
	else if (!state.logged_in) message = '登录会员后查看订阅用量';
	else if (!state.quota) message = '会员服务暂未提供用量';
	if (message) return E('section', { 'class': 'dd-quota', 'aria-label': '会员订阅用量' }, [
		text('span', { 'class': 'dd-quota-label' }, '会员流量'),
		text('span', { 'class': 'dd-quota-empty' }, message)
	]);
	const summary = [text('span', { 'class': 'dd-quota-amount' }, '已用 ' + formatBytes(used) + ' / ' + formatBytes(total))];
	if (percent !== null) summary.push(E('span', { 'class': 'dd-quota-meter' }, [
		E('span', {
			'class': 'dd-quota-track', 'role': 'progressbar', 'aria-label': '会员流量已用比例',
			'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, percent)
		}, [E('span', { 'class': 'dd-quota-fill', 'style': 'width:' + Math.min(100, percent) + '%' })]),
		text('span', { 'class': 'dd-quota-percent' }, percent > 0 && percent < 0.1 ? '<0.1%' : Number(percent.toFixed(1)) + '%')
	]));
	const nodes = [E('div', { 'class': 'dd-quota-row' }, [
		text('span', { 'class': 'dd-quota-label' }, '套餐'),
		text('span', { 'class': 'dd-quota-plan' }, typeof quota.planName === 'string' && quota.planName ? quota.planName : '未提供'),
		E('div', { 'class': 'dd-quota-summary' }, summary)
	])];
	const expires = typeof quota.expiresAt === 'string' ? new Date(quota.expiresAt) : null;
	const expiry = typeof quota.expiresText === 'string' && quota.expiresText ? quota.expiresText :
		expires && Number.isFinite(expires.getTime()) ? '到期 ' + expires.toLocaleDateString() : '到期时间未提供';
	const warning = percent >= 100 ? ' · 额度已用尽' : percent >= 80 ? ' · 流量即将用尽' : '';
	const usageTier = percent === null || !Number.isFinite(percent) ? ''
		: percent >= 100 ? ' dd-quota-t4'
		: percent >= 80 ? ' dd-quota-t3'
		: percent >= 60 ? ' dd-quota-t2'
		: ' dd-quota-t1';
	nodes.push(E('div', { 'class': 'dd-quota-row dd-quota-meta' }, [
		text('span', {}, '剩余 ' + formatBytes(remaining) + warning),
		text('span', {}, expiry)
	]));
	return E('section', { 'class': 'dd-quota' + usageTier + (warning ? ' dd-quota-warning' : ''), 'aria-label': '会员订阅用量' }, nodes);
}

function render(ctx) {
	const state = ctx.memberState || {};
	if (state.warning === 'Upstream unavailable: this configuration uses a saved subscription snapshot. Review the member website.')
		state.warning = '云端暂时无法获取最新订阅，本次使用已保存的订阅快照。请稍后再次同步。';
	let card;
	const modeBadge = E('span', { 'class': 'dd-member-mode' + (state.mode === 'cloud' ? ' dd-member-mode-cloud' : '') });
	function updateMode() {
		const cloud = state.logged_in && state.mode === 'cloud';
		modeBadge.textContent = state.logged_in ? (cloud ? '云端配置' : '本地配置') : '';
		modeBadge.className = 'dd-member-mode' + (cloud ? ' dd-member-mode-cloud' : '');
		modeBadge.hidden = !state.logged_in;
		modeBadge.title = cloud ? '规则由会员服务同步，本地编辑已锁定' : '';
	}
	updateMode();
	const memberName = E('span', { 'class': 'dd-member-name' });
	memberName.textContent = state.logged_in && typeof (state.quota || {}).memberName === 'string' ? state.quota.memberName : '';
	memberName.title = memberName.textContent ? '会员：' + memberName.textContent : '';
	const url = E('input', { 'type': 'url', 'class': 'cbi-input-text', 'placeholder': 'https://规则系统域名', 'value': state.url || '', 'autocomplete': 'url' });
	const username = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'autocomplete': 'username' });
	const password = E('input', { 'type': 'password', 'class': 'cbi-input-password', 'autocomplete': 'current-password' });
	function normalizeOrigin(value) {
		try {
			const parsed = new URL(value.trim());
			if (parsed.protocol !== 'https:') throw new Error('会员服务地址必须使用 HTTPS');
			if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('会员服务地址不能包含账号、参数或锚点');
			return parsed.origin;
		} catch (e) {
			if (e.message === '会员服务地址必须使用 HTTPS' || e.message === '会员服务地址不能包含账号、参数或锚点') throw e;
			throw new Error('请输入有效的 HTTPS 会员服务地址');
		}
	}
	const lan = E('select', { 'class': 'cbi-input-select' });
	lan.appendChild(E('option', { 'value': '' }, '请选择 LAN 接口'));
	(ctx.netDevs || []).forEach(function(name) { lan.appendChild(E('option', { 'value': name }, name)); });
	lan.value = state.lan_interface || '';
	const feedback = E('p', { 'class': 'dd-member-feedback', 'role': 'status', 'aria-live': 'polite' }, ctx.memberError || state.last_error || (state.logged_in ? state.warning : '') || ctx.memberRefreshNote || '');
	const buttons = [];
	function action(label, handler, primary) {
		const button = E('button', { 'type': 'button', 'class': 'cbi-button ' + (primary ? 'cbi-button-action' : 'cbi-button-neutral'), 'aria-label': label }, label);
		button.addEventListener('click', function() {
			const previous = buttons.map(function(b) { return b.disabled; });
			buttons.forEach(function(b) { b.disabled = true; });
			button.textContent = '处理中…';
			button.className += ' dd-member-busy';
			feedback.textContent = '';
			Promise.resolve().then(handler).catch(function(error) {
				feedback.textContent = error.message || '操作失败';
			}).finally(function() {
				password.value = '';
				button.textContent = label;
				button.className = button.className.replace(' dd-member-busy', '');
				buttons.forEach(function(b, index) { b.disabled = previous[index]; });
			});
		});
		buttons.push(button);
		return button;
	}

	function refreshMember(fallback, notice) {
		// 登录不改变配置来源，只替换会员卡，保留其他表单及页面位置。
		return getStatus().then(function(nextState) {
			return { state: nextState, error: null };
		}, function() {
			return { state: fallback, error: notice + '，但会员状态暂时无法更新，请稍后重试。' };
		}).then(function(result) {
			if (card.isConnected === false) return;
			const x = window.scrollX, y = window.scrollY;
			const next = render(Object.assign({}, ctx, {
				memberState: result.state, memberError: result.error, memberRefreshNote: notice
			}));
			card.replaceWith(next);
			if (state.mode !== result.state.mode && typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('daede-member-state', { detail: result.state }));
			if (typeof window.scrollTo === 'function') window.scrollTo({ left: x, top: y, behavior: 'instant' });
		});
	}
	function field(label, input) {
		return E('label', { 'class': 'dd-member-field' }, [E('span', {}, label), input]);
	}
	function stateText() {
		if (!state.logged_in) return '未登录';
		const syncTime = state.last_sync ? new Date(state.last_sync).getTime() : 0;
		const elapsed = syncTime ? Math.max(0, Date.now() - syncTime) : 0;
		let recent = '';
		if (syncTime) {
			if (elapsed < 60 * 1000) recent = '刚刚';
			else if (elapsed < 60 * 60 * 1000) recent = Math.floor(elapsed / 60000) + ' 分钟前';
			else if (elapsed < 24 * 60 * 60 * 1000) recent = Math.floor(elapsed / 3600000) + ' 小时前';
			else recent = new Date(syncTime).toLocaleString();
		}
		const connection = state.quota_status === 'unavailable' ? '状态待核验' : '已连接';
		const config = !state.last_sync ? '未同步' : state.mode !== 'cloud' ? '本地模式'
			: state.running === true ? '已加载，运行中' : state.running === false ? '已同步，服务未运行' : '已同步，运行状态待核验';
		const subscription = !state.last_sync ? '未同步' : state.warning ? '有提示（见下方）' : '最近同步无警告';
		return (state.logged_in ? connection : '未登录') + ' · ' +
			(recent ? '最近同步 ' + recent + ' · ' : '') +
			'配置状态：' + config + ' · 订阅状态：' + subscription;
	}
	const stateLine = E('p', { 'class': 'dd-member-state' }, stateText());
	function scheduleText() {
        if (!state.auto_sync) return '自动同步未开启';
        if (state.mode !== 'cloud') return '本地模式下暂停自动同步';
        if (state.running === false) return '服务已关闭，自动同步暂停';
        const next = Number(state.next_sync);
        return next > 0 ? '下次同步 ' + new Date(next * 1000).toLocaleString('zh-CN', { hour12: false }) : '等待定时检查';
    }
    const scheduleLine = E('p', { 'class': 'dd-member-note', 'aria-live': 'polite' }, scheduleText());
    const syncHours = E('input', {
		type: 'number', min: '1', max: '24', step: '1',
		'class': 'cbi-input-text', 'aria-label': '同步间隔（小时）',
		style: 'display:block;box-sizing:border-box;width:100%;flex:1 1 auto;min-width:0',
		value: state.sync_interval || '6'
	});
	const syncSchedule = E('button', { type: 'button', class: 'cbi-button cbi-button-neutral', style: 'flex:0 0 auto;margin:0;white-space:nowrap' }, '保存同步周期');
	syncSchedule.disabled = !state.logged_in || String(syncHours.value) === String(state.sync_interval || '6');
	syncHours.addEventListener('input', function() { syncSchedule.disabled = !state.logged_in || String(syncHours.value) === String(state.sync_interval || '6'); });
	buttons.push(syncSchedule);
	syncSchedule.addEventListener('click', function() {
		const hours = String(syncHours.value || '').trim();
		syncSchedule.disabled = true;
		syncSchedule.textContent = '保存中…';
		invoke('schedule', [hours]).then(function(result) {
            state.sync_interval = hours; state.auto_sync = true; state.next_sync = result.next_sync;
            scheduleLine.textContent = scheduleText();
            feedback.textContent = '✓ 已保存，每 ' + hours + ' 小时同步';
			ui.addNotification(null, E('p', {}, '同步周期已保存，每 ' + hours + ' 小时同步'), 'info');
		}).catch(function(error) {
			ui.addNotification(null, E('p', {}, error.message || '保存同步周期失败'), 'error');
		}).finally(function() {
			syncSchedule.textContent = '保存同步周期';
			syncSchedule.disabled = !state.logged_in || String(syncHours.value) === String(state.sync_interval || '6');
		});
	});
	const syncScheduleBox = E('div', { class: 'dd-member-field dd-member-sync-field' }, [
		E('span', {}, '自动同步间隔（小时）'),
		E('div', {
			class: 'dd-member-sync-control',
			style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:7px;min-width:0'
		}, [syncHours, syncSchedule])
	]);
	const signIn = action(state.logged_in ? '重新登录' : '登录会员', function() {
		if (!url.value.trim() || !username.value.trim() || !password.value || !lan.value)
			throw new Error('请填写系统地址、账号、密码并选择 LAN 接口');
		const origin = normalizeOrigin(url.value), selected = lan.value;
		url.value = origin;
		return login({ url: origin, username: username.value.trim(), password: password.value, lan_interface: selected }).then(function() {
			password.value = '';
			return refreshMember(Object.assign({}, state, {
				logged_in: true, url: origin, lan_interface: selected, quota: null, quota_status: 'unavailable'
			}), '登录成功');
		});
	}, !state.logged_in);
	const sync = action(state.running === false ? '应用并启用' : '应用云端配置', function() {
		return invoke('sync', [], function(phase) { feedback.textContent = phase; }).then(function(result) {
			const modeChanged = state.mode !== 'cloud';
			state.logged_in = true;
			state.mode = 'cloud';
			updateMode();
			state.last_sync = result.last_sync || new Date().toISOString();
			state.warning = result.warning || '';
			state.running = result.running === true;
            state.next_sync = result.next_sync; state.last_error = '';
            scheduleLine.textContent = scheduleText();
			stateLine.textContent = stateText();
			local.hidden = false;
			if (modeChanged && typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('daede-member-state', { detail: state }));
			feedback.textContent = '✓ 同步成功，配置已应用，服务运行中；节点连通性可通过服务区测试。' + (state.warning ? ' ' + state.warning : '');
			ui.addNotification(null, E('p', {}, feedback.textContent), 'info');
		});
	}, true);
	sync.disabled = !state.logged_in || !!ctx.memberError;
	const logout = action('退出登录', function() {
		return invoke('logout').then(function() {
			return refreshMember(Object.assign({}, state, { logged_in: false, quota: null, quota_status: 'unauthenticated' }), '已退出登录');
		});
	});
	logout.disabled = !state.logged_in;
	const local = action('切换到本地编辑', function() {
		ui.showModal('切换配置来源', [
			E('p', {}, '现有配置会保留。切换后，本地表单保存将重新生成配置。再次同步会员配置会恢复云端模式。'),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, '取消'),
				' ',
				E('button', { 'class': 'cbi-button cbi-button-action', 'click': function(ev) {
					ev.currentTarget.disabled = true;
					invoke('local').then(function() { ui.hideModal(); return refreshMember(Object.assign({}, state, { mode: 'local' }), '已切换到本地编辑'); }).catch(function(error) { ui.hideModal(); feedback.textContent = error.message; });
				} }, '切换到本地')
			])
		]);
	});
	local.hidden = state.mode !== 'cloud';
	const credentials = E('div', { 'class': 'dd-member-fields', 'style': state.logged_in ? 'display:none' : '' }, [
		field('系统地址', url),
		E('div', { 'class': 'dd-member-grid' }, [field('账号', username), field('密码', password), field('LAN 接口', lan), syncScheduleBox]),
		E('div', { 'class': 'dd-member-actions' }, [signIn, logout]),
		E('p', { 'class': 'dd-member-note' }, '密码仅用于本次登录，不会保存。')
	]);
	const settings = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-neutral' }, '账户设置');
	settings.hidden = !state.logged_in;
    settings.setAttribute && settings.setAttribute('aria-expanded', 'false');
	settings.addEventListener('click', function() {
		const opening = credentials.style.display === 'none';
		credentials.style.display = opening ? 'grid' : 'none';
		settings.textContent = opening ? '收起设置' : '账户设置';
        settings.setAttribute && settings.setAttribute('aria-expanded', String(opening));
	});
	const usage = renderUsage(ctx);
	const cardChildren = [
		E('div', { 'class': 'dd-member-head' }, [
			E('h4', { 'class': 'dd-card-title' }, '会员配置'),
            state.logged_in ? E('span', { 'class': 'dd-member-vip', 'aria-label': '会员' }, 'VIP') : null, memberName, modeBadge
		])
	];
	if (usage) cardChildren.push(usage);
	cardChildren.push(
		stateLine, scheduleLine,
		credentials,
		E('div', { 'class': 'dd-member-actions' }, [sync, local, settings]),
		E('p', { 'class': 'dd-member-note' }, state.logged_in && state.mode === 'cloud' ? '当前由云端统一管理规则；如需手动修改，请先切换到本地编辑。' : '登录会员后可使用云端规则；本地模式下可手动调整配置。'),
		feedback
	);
	card = E('div', { 'class': 'dd-card dd-member-card' + (ctx.memberRefreshNote === '登录成功' ? ' dd-member-welcome' : '') }, cardChildren);
	return card;
}

return baseclass.extend({ getStatus: getStatus, assertLocal: assertLocal, render: render, renderUsage: renderUsage });
