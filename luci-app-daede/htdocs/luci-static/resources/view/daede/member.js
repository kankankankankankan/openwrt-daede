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

function render(ctx) {
	const state = ctx.memberState || {};
	const url = E('input', { 'type': 'url', 'class': 'cbi-input-text', 'placeholder': 'https://规则系统域名', 'value': state.url || '', 'autocomplete': 'url' });
	const username = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'autocomplete': 'username' });
	const password = E('input', { 'type': 'password', 'class': 'cbi-input-password', 'autocomplete': 'current-password' });
	const lan = E('select', { 'class': 'cbi-input-select' });
	(ctx.netDevs || []).forEach(function(name) { lan.appendChild(E('option', { 'value': name }, name)); });
	lan.value = state.lan_interface || 'br-lan';
	if (!lan.value && lan.options.length) lan.selectedIndex = 0;
	const feedback = E('p', { 'class': 'dd-member-feedback', 'role': 'status', 'aria-live': 'polite' }, ctx.memberError || state.warning || '');
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
	function field(label, input) {
		return E('label', { 'class': 'dd-member-field' }, [E('span', {}, label), input]);
	}
	function stateText() {
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
			(state.mode === 'cloud' ? '云端配置' : '本地配置') +
			(recent ? ' · 最近同步 ' + recent : '') +
			' · 规则状态：' + rules;
	}
	const stateLine = E('p', { 'class': 'dd-member-state' }, stateText());
	const signIn = action(state.logged_in ? '重新登录' : '登录会员', function() {
		if (!url.value.trim() || !username.value.trim() || !password.value || !lan.value)
			throw new Error('请填写系统地址、账号、密码并选择 LAN 接口');
		return login({ url: url.value.trim(), username: username.value.trim(), password: password.value, lan_interface: lan.value }).then(reload);
	}, !state.logged_in);
	const sync = action('同步并启用', function() {
		return invoke('sync').then(function(result) {
			state.logged_in = true;
			state.mode = 'cloud';
			state.last_sync = result.last_sync || new Date().toISOString();
			stateLine.textContent = stateText();
			local.hidden = false;
			feedback.textContent = '同步成功，dae 已启用并开始运行。';
		});
	}, true);
	sync.disabled = !state.logged_in || !!ctx.memberError;
	const logout = action('退出登录', function() { return invoke('logout').then(reload); });
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
		E('div', { 'class': 'dd-member-actions' }, [signIn, logout]),
		E('p', { 'class': 'dd-member-note' }, '密码仅用于本次登录，不会保存。')
	]);
	const settings = E('button', { 'type': 'button', 'class': 'cbi-button cbi-button-neutral' }, '账户设置');
	settings.hidden = !state.logged_in;
	settings.addEventListener('click', function() {
		const opening = credentials.style.display === 'none';
		credentials.style.display = opening ? 'grid' : 'none';
		settings.textContent = opening ? '收起设置' : '账户设置';
	});
	return E('div', { 'class': 'dd-card' }, [
		E('h4', { 'class': 'dd-card-title' }, '会员配置'),
		stateLine,
		credentials,
		E('div', { 'class': 'dd-member-actions' }, [sync, settings, local]),
		feedback
	]);
}

return baseclass.extend({ getStatus: getStatus, assertLocal: assertLocal, render: render });
