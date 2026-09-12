'use strict';
'require baseclass';

function call(item, method) {
  if (!item) return undefined;
  return typeof item[method] === 'function' ? item[method]() : item[method];
}
function name(item) { return call(item, 'getName') || ''; }
function deviceName(network) {
  var d = call(network, 'getL2Device') || call(network, 'getDevice');
  return name(d) || (typeof d === 'string' ? d : '');
}
function isUsable(network) {
  if (!network || !deviceName(network)) return false;
  var up = call(network, 'isUp');
  return up === true;
}
function makeResult(saved, recommended, status, message) {
  return { value: saved || recommended || '', recommended: recommended || '', status: status, message: message };
}
function recommendLanInterface(input) {
  input = input || {};
  var saved = input.saved || '';
  var missing = saved && Array.isArray(input.devices) && input.devices.length && saved.split(/[,\s]+/).filter(Boolean).some(function(d) { return input.devices.indexOf(d) === -1; });
  var warning = missing ? '已保存的接口在当前设备列表中不存在，请检查：' + saved + '。' : '';
  var networks = (input.networks || []).filter(isUsable);
  var standard = networks.filter(function(n) { return name(n) === 'lan'; });
  var candidates = standard.map(deviceName).filter(Boolean);
  var evidence = 'LAN 网络映射';
  if (candidates.length !== 1 && !standard.length && input.zones) {
    var zone = (input.zones || []).filter(function(z) { return name(z) === 'lan'; });
    var zoneNames = zone.length === 1 && typeof zone[0].getNetworks === 'function' ? zone[0].getNetworks() : [];
    candidates = networks.filter(function(n) { return zoneNames.indexOf(name(n)) !== -1; }).map(deviceName).filter(Boolean);
    evidence = '防火墙 LAN 区域映射';
  }
  var unique = candidates.filter(function(v, i, a) { return a.indexOf(v) === i; });
  if (unique.length === 1) {
    var rec = unique[0];
    return makeResult(saved, rec, saved ? 'saved' : 'recommended', warning + (saved ? '已保留原值：' + saved + '。' : '') + '已根据' + evidence + '推荐接口：' + rec + '；保存后才生效。');
  }
  return makeResult(saved, '', saved ? 'saved' : 'manual', warning + (saved ? '无法验证推荐接口，已保留原值，请手动确认：' + saved : '没有唯一可验证的 LAN 接口，请手动选择；不会自动使用第一个设备。'));
}
return baseclass.extend({ recommendLanInterface: recommendLanInterface });
