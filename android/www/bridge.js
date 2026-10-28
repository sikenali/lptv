(function(){if(window.__lptvBridge)return;window.__lptvBridge=true;
var _channels=null,_logoCache={},_state=null;
/* 读取本地 channels.json */
function loadChannels(){return fetch('channels.json').then(function(r){return r.json();}).then(function(c){_channels=c;return c;}).catch(function(){_channels=[];return[];});}
/* 读取台标 webp */
function loadLogo(pid){if(_logoCache[pid])return Promise.resolve(_logoCache[pid]);if(!/^\d+$/.test(String(pid)))return Promise.resolve('');return fetch('logos/'+pid+'.webp').then(function(r){return r.blob();}).then(function(b){return new Promise(function(resolve){var reader=new FileReader();reader.onloadend=function(){_logoCache[pid]=reader.result;resolve(_logoCache[pid]);};reader.readAsDataURL(b);});}).catch(function(){return '';});}
/* UI 状态 (localStorage 持久化) */
var LS_KEY='lptv.cfg.v3';
function loadState(){try{_state=JSON.parse(localStorage.getItem(LS_KEY)||'{}');}catch(e){_state={};}return _state||{};}
function saveState(patch){_state=Object.assign(_state||{},patch);try{localStorage.setItem(LS_KEY,JSON.stringify(_state));}catch(e){}}
/* 延迟设置 window.lptv，等 channels 加载完 */
window.lptv={
  get_channels:function(){return Promise.resolve(_channels||[]);},
  get_version:function(){return Promise.resolve('1.0.0');},
  get_asset_image:function(name,prefix){
    if(prefix==='logos'&&/^\d+$/.test(name))return loadLogo(name);
    return Promise.resolve({ok:false,src:''});
  },
  get_ui_state:function(){return Promise.resolve(Object.assign({ok:true},loadState()));},
  set_ui_state:function(patch){try{if(typeof patch==='string')patch=JSON.parse(patch);saveState(patch);}catch(e){return Promise.reject(e);}return Promise.resolve({ok:true});},
  play_channel:function(pid){
    var iframe=document.getElementById('lptv-iframe');
    if(iframe&&pid){iframe.src='https://www.yangshipin.cn/tv/home?pid='+encodeURIComponent(String(pid));}
    return Promise.resolve({ok:true});
  },
  shot_save:function(_chname,b64data){
    try{var img=document.createElement('img');img.src=b64data;img.onload=function(){var c=document.createElement('canvas');c.width=img.naturalWidth||1280;c.height=img.naturalHeight||720;c.getContext('2d').drawImage(img,0,0);var a=document.createElement('a');a.download=(chname||'直播')+'_'+Date.now()+'.png';a.href=c.toDataURL();a.click();};}catch(e){}
    return Promise.resolve({ok:true});
  },
  rec_open:function(){return Promise.resolve({ok:false,error:'Android unsupported'});},
  rec_append:function(){return Promise.resolve({ok:false});},
  rec_close:function(){return Promise.resolve({ok:false});},
  minimize:function(){return Promise.resolve({ok:false});},
  maximize_toggle:function(){return Promise.resolve({ok:false,maximized:false});},
  is_maximized:function(){return Promise.resolve({ok:true,maximized:false});},
  fullscreen_toggle:function(){try{var e=document.documentElement;if(e.requestFullscreen)e.requestFullscreen();else if(e.webkitRequestFullscreen)e.webkitRequestFullscreen();}catch(ex){}return Promise.resolve({ok:true,fullscreen:false});},
  is_fullscreen:function(){return Promise.resolve({ok:true,fullscreen:false});},
  float_toggle:function(){return Promise.resolve({ok:false});},
  is_float:function(){return Promise.resolve({ok:true,floating:false});},
  pin_toggle:function(){return Promise.resolve({ok:false});},
  pin_state:function(){return Promise.resolve({ok:true,pinned:false});},
  resize_win:function(){return Promise.resolve({ok:false});},
  win_pos:function(){return Promise.resolve({ok:true,x:0,y:0,w:0,h:0});},
  move_win:function(){return Promise.resolve({ok:false});},
  close_window:function(){return Promise.resolve({ok:false});},
  get_save_dirs:function(){return Promise.resolve({ok:true,rec:'/storage/emulated/0/Download/LPTV/录制',shot:'/storage/emulated/0/Download/LPTV/截图'});},
  pick_save_dir:function(){return Promise.resolve({ok:false});},
  open_save_dir:function(){return Promise.resolve({ok:false});},
  autostart_state:function(){return Promise.resolve({ok:true,value:false});},
  autostart_set:function(){return Promise.resolve({ok:true});},
  copy_m3u8:function(){return Promise.resolve({ok:false});}
};
loadChannels();loadState();
})();
