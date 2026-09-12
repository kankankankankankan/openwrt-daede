// SPDX-License-Identifier: Apache-2.0
'use strict';
'require baseclass';
'require fs';
'require ui';

// 2026-09-11: Keep member credentials in a private one-use request, never in argv or UCI.
const HELPER = '/usr/share/luci-app-daede/member-sync.sh';

function invoke(action, args) {
	return fs.exec(HELPER, [action].concat(args || [])).then(function(result) {
		let body;
		try { body = JSON.parse(result.stdout || '{}'); }
		catch (e) { throw new Error('会员服务返回异常，请检查插件是否完整安装'); }
		if (!body.ok || result.code !== 0)
			throw new Error(body.error || '操作失败，请检查服务地址和路由器网络');
		return body;
	});
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
	nodes.push(E('div', { 'class': 'dd-quota-row dd-quota-meta' }, [
		text('span', {}, '剩余 ' + formatBytes(remaining) + warning),
		text('span', {}, expiry)
	]));
	return E('section', { 'class': 'dd-quota' + (warning ? ' dd-quota-warning' : ''), 'aria-label': '会员订阅用量' }, nodes);
}

function render(ctx) {
	const state = ctx.memberState || {};
	let card;
	const modeBadge = E('span', { 'class': 'dd-member-mode' + (state.mode === 'cloud' ? ' dd-member-mode-cloud' : '') });
	function updateMode() {
		modeBadge.textContent = state.mode === 'cloud' ? '云端配置' : '本地配置';
		modeBadge.className = 'dd-member-mode' + (state.mode === 'cloud' ? ' dd-member-mode-cloud' : '');
		modeBadge.title = state.mode === 'cloud' ? '规则由会员服务同步，本地编辑已锁定' : '规则由本地表单或配置编辑器管理';
	}
	updateMode();
	const memberName = E('span', { 'class': 'dd-member-name' });
	memberName.textContent = state.logged_in && typeof (state.quota || {}).memberName === 'string' ? state.quota.memberName : '';
	memberName.title = memberName.textContent ? '会员：' + memberName.textContent : '';
	const url = E('input', { 'type': 'url', 'class': 'cbi-input-text', 'placeholder': 'https://规则系统域名', 'value': state.url || '', 'autocomplete': 'url' });
	const username = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'autocomplete': 'username' });
	const password = E('input', { 'type': 'password', 'class': 'cbi-input-password', 'autocomplete': 'current-password' });
	const lan = E('select', { 'class': 'cbi-input-select' });
	lan.appendChild(E('option', { 'value': '' }, '请选择 LAN 接口'));
	(ctx.netDevs || []).forEach(function(name) { lan.appendChild(E('option', { 'value': name }, name)); });
	const recommendation = ctx.memberLanRecommendation || ctx.lanRecommendation || { value: '', status: 'manual', message: '没有唯一可验证的 LAN 接口，请手动选择。' };
	const selectedLan = state.lan_interface || recommendation.value || '';
	[selectedLan, recommendation.recommended].forEach(function(name) {
		if (name && !Array.prototype.some.call(lan.options, function(o) { return o.value === name; }))
			lan.appendChild(E('option', { 'value': name }, name));
	});
	lan.value = selectedLan;
	const feedback = E('p', { 'class': 'dd-member-feedback', 'role': 'status', 'aria-live': 'polite' }, ctx.memberError || (state.logged_in ? state.warning : '') || ctx.memberRefreshNote || recommendation.message || '');
	const buttons = [];
	function action(label, handler, primary) {
		const button = E('button', { 'type': 'button', 'class': 'cbi-button ' + (primary ? 'cbi-button-action' : 'cbi-button-neutral') }, label);
		button.addEventListener('click', function() {
			const previous = buttons.map(function(b) { return b.disabled; });
			buttons.forEach(function(b) { b.disabled = true; });
			button.textContent = '处理中…';
			feedback.textContent = '';
			Promise.resolve().then(handler).catch(function(error) {
				feedback.textContent = error.message || '操作失败';
			}).finally(function() {
				password.value = '';
				button.textContent = label;
				buttons.forEach(function(b, index) { b.disabled = previous[index]; });
			});
		});
		buttons.push(button);
		return button;
	}
	function reload() { window.location.reload(); }
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
		const rules = !state.last_sync ? '未同步' : state.warning ? '需检查' : '已加载';
		return (state.logged_in ? '已连接' : '未登录') + ' · ' +
			(recent ? '最近同步 ' + recent + ' · ' : '') +
			'规则状态：' + rules;
	}
	const stateLine = E('p', { 'class': 'dd-member-state' }, stateText());
	const signIn = action(state.logged_in ? '重新登录' : '登录会员', function() {
		if (!url.value.trim() || !username.value.trim() || !password.value || !lan.value)
			throw new Error('请填写系统地址、账号、密码并选择 LAN 接口');
		const origin = url.value.trim(), selected = lan.value;
		return login({ url: origin, username: username.value.trim(), password: password.value, lan_interface: selected }).then(function() {
			password.value = '';
			return refreshMember(Object.assign({}, state, {
				logged_in: true, url: origin, lan_interface: selected, quota: null, quota_status: 'unavailable'
			}), '登录成功');
		});
	}, !state.logged_in);
	const recommend = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-neutral' }, '使用推荐接口');
	recommend.disabled = !recommendation.recommended;
	recommend.addEventListener('click', function() {
		if (recommendation.recommended) {
			lan.value = recommendation.recommended;
			feedback.textContent = '已选择推荐接口，登录后生效；现有运行配置尚未修改。';
		}
	});
	const sync = action('同步并启用', function() {
		return invoke('sync').then(function(result) {
			state.logged_in = true;
			state.mode = 'cloud';
			updateMode();
			state.last_sync = result.last_sync || new Date().toISOString();
			state.warning = result.warning || '';
			stateLine.textContent = stateText();
			local.hidden = false;
			feedback.textContent = state.warning || '同步成功，dae 已启用并开始运行。';
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
				E('button', { 'class': 'cbi-button cbi-button-action', 'click': function(ev) {
					ev.currentTarget.disabled = true;
					invoke('local').then(reload).catch(function(error) { ui.hideModal(); feedback.textContent = error.message; });
				} }, '切换到本地')
			])
		]);
	});
	local.hidden = state.mode !== 'cloud';
	const credentials = E('div', { 'class': 'dd-member-fields', 'style': state.logged_in ? 'display:none' : '' }, [
		field('系统地址', url),
		E('div', { 'class': 'dd-member-grid' }, [field('账号', username), field('密码', password), field('LAN 接口', lan)]),
		E('div', { 'class': 'dd-member-actions' }, [signIn, recommend, logout]),
		E('p', { 'class': 'dd-member-note' }, '密码仅用于本次登录，不会保存。')
	]);
	const settings = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-neutral' }, '账户设置');
	settings.hidden = !state.logged_in;
	settings.addEventListener('click', function() {
		const opening = credentials.style.display === 'none';
		credentials.style.display = opening ? 'grid' : 'none';
		settings.textContent = opening ? '收起设置' : '账户设置';
	});
	card = E('div', { 'class': 'dd-card dd-member-card' }, [
		E('div', { 'class': 'dd-member-head' }, [
			E('h4', { 'class': 'dd-card-title' }, '会员配置'), memberName, modeBadge
		]),
		stateLine,
		renderUsage(ctx),
		credentials,
		E('div', { 'class': 'dd-member-actions' }, [sync, settings, local]),
		feedback
	]);
	return card;
}

return baseclass.extend({ getStatus: getStatus, assertLocal: assertLocal, render: render, renderUsage: renderUsage });
