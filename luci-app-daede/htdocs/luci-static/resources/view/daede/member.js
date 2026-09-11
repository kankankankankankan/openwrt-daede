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
	const url = E('input', { 'type': 'url', 'class': 'cbi-input-text', 'placeholder': 'https://你的规则系统域名', 'value': state.url || '', 'autocomplete': 'url' });
	const username = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'autocomplete': 'username' });
	const password = E('input', { 'type': 'password', 'class': 'cbi-input-password', 'autocomplete': 'current-password' });
	const lan = E('select', { 'class': 'cbi-input-select' });
	(ctx.netDevs || []).forEach(function(name) { lan.appendChild(E('option', { 'value': name }, name)); });
	lan.value = state.lan_interface || 'br-lan';
	if (!lan.value && lan.options.length) lan.selectedIndex = 0;
	const feedback = E('p', { 'role': 'status', 'aria-live': 'polite', 'style': 'white-space:pre-wrap;overflow-wrap:anywhere' }, ctx.memberError || state.warning || '');
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
		return E('label', { 'style': 'display:flex;flex-direction:column;gap:6px;min-width:0' }, [E('span', {}, label), input]);
	}
	const signIn = action(state.logged_in ? '重新登录' : '登录会员', function() {
		if (!url.value.trim() || !username.value.trim() || !password.value || !lan.value)
			throw new Error('请填写系统地址、账号、密码并选择 LAN 接口');
		return login({ url: url.value.trim(), username: username.value.trim(), password: password.value, lan_interface: lan.value }).then(reload);
	}, !state.logged_in);
	const sync = action('同步并启用', function() { return invoke('sync').then(reload); }, true);
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
	return E('div', { 'class': 'dd-card' }, [
		E('h4', { 'class': 'dd-card-title' }, '会员配置'),
		E('p', {}, (state.logged_in ? '会员已登录' : '会员未登录') + ' · ' + (state.mode === 'cloud' ? '云端配置' : '本地配置')),
		state.last_sync ? E('p', {}, '上次成功同步：' + state.last_sync) : '',
		E('p', {}, '登录 Surge DNA 后获取 dae 配置。系统地址使用你部署会员配置中心的 HTTPS 域名。'),
		E('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:16px 0' }, [
			field('规则系统地址', url), field('会员账号', username), field('会员密码', password), field('LAN 接口', lan)
		]),
		E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:8px' }, [signIn, sync, logout, local]),
		feedback,
		E('p', { 'style': 'font-size:12px;opacity:.8' }, '密码不保存。路由器重启后需重新登录才能同步，已保存配置继续使用。上游要求验证码时，当前请使用会员网页下载配置。')
	]);
}

return baseclass.extend({ getStatus: getStatus, assertLocal: assertLocal, render: render });
