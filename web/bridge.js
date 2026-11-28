(function(){if(window.__lptvBridge)return;window.__lptvBridge=true;
var _channels=null,_logoCache={},_state=null;

/* 央视频网站加载进 iframe 就绪标志: 启动首页=splash 动画里加载央视频网站,
   就绪后 (__LPTV_YSP_READY=true) 淡出露首页。由 splash.js 判定。 */
(function(){
  try{
    var _if=document.getElementById('lptv-iframe');
    if(_if)_if.addEventListener('load',function(){window.__LPTV_YSP_READY=true;});
  }catch(e){}
})();

/* 从预加载数据读取频道 */
function loadChannels(){
  if(window.__lptvPreload && window.__lptvPreload.channels){
    _channels=window.__lptvPreload.channels;
    return Promise.resolve(_channels);
  }
  return fetch('channels.json').then(function(r){return r.json();}).then(function(c){_channels=c;return c;}).catch(function(){_channels=[];return[];});
}

/* 从预加载数据或 fetch 读取台标 */
function loadLogo(pid){
  if(_logoCache[pid])return Promise.resolve(_logoCache[pid]);
  if(!/^\d+$/.test(String(pid)))return Promise.resolve('');
  /* 优先从预加载读取 */
  if(window.__lptvPreload && window.__lptvPreload.logos && window.__lptvPreload.logos[pid]){
    _logoCache[pid]=window.__lptvPreload.logos[pid];
    return Promise.resolve(_logoCache[pid]);
  }
  /* 兜底: fetch 大台标 */
  return fetch('logos/'+pid+'.webp').then(function(r){return r.blob();}).then(function(b){
    return new Promise(function(resolve){
      var reader=new FileReader();
      reader.onloadend=function(){_logoCache[pid]=reader.result;resolve(_logoCache[pid]);};
      reader.readAsDataURL(b);
    });
  }).catch(function(){return '';});
}

/* UI 状态 (localStorage 持久化) */
var LS_KEY='lptv.cfg.v3';
function loadState(){try{_state=JSON.parse(localStorage.getItem(LS_KEY)||'{}');}catch(e){_state={};}return _state||{};}
function saveState(patch){_state=Object.assign(_state||{},patch);try{localStorage.setItem(LS_KEY,JSON.stringify(_state));}catch(e){}}

window.lptv={
  get_channels:function(){return Promise.resolve(_channels||[]);},
  get_version:function(){return Promise.resolve('1.0.0');},
  get_asset_image:function(name,prefix){
    /* 契约与 Electron 侧一致: name 可带 .webp 后缀, 返回 {ok,src};
       inject.js 传的是 pid + '.webp'，这里去掉后缀后按 pid 取台标。 */
    if(prefix==='logos'){
      var pid=String(name||'').replace(/\.webp$/i,'');
      if(/^\d+$/.test(pid))return loadLogo(pid).then(function(src){
        return src?{ok:true,src:src}:{ok:false,src:''};
      });
    }
    /* 首页背景等本地资源: 网页版/APK 的 index.html 与资源同源, 直接 fetch 后转 data URI */
    if(prefix==='assets' && name){
      return fetch(String(name)).then(function(r){return r.blob();}).then(function(b){
        return new Promise(function(resolve){
          var reader=new FileReader();
          reader.onloadend=function(){resolve({ok:true,src:reader.result});};
          reader.readAsDataURL(b);
        });
      }).catch(function(){return {ok:false,src:''};});
    }
    return Promise.resolve({ok:false,src:''});
  },
  get_ui_state:function(){return Promise.resolve(Object.assign({ok:true},loadState()));},
  set_ui_state:function(patch){try{if(typeof patch==='string')patch=JSON.parse(patch);saveState(patch);}catch(e){return Promise.reject(e);}return Promise.resolve({ok:true});},
  play_channel:function(pid){
    var iframe=document.getElementById('lptv-iframe');
    var base=(window.__LPTV_YSP_BASE!==undefined)?window.__LPTV_YSP_BASE:'https://www.yangshipin.cn';
    var apply=function(){if(iframe&&pid){iframe.src=base+'/tv/home?pid='+encodeURIComponent(String(pid));}};
    /* 智慧屏版：先等 Service Worker 接管，再把央视频页放进同源 iframe，
       否则页面里对 capi.yangshipin.cn 等接口的跨域请求会因无 CORS 头失败。 */
    if(window.__LPTV_SW_READY===false){
      var tries=0;
      var timer=setInterval(function(){tries++;if(window.__LPTV_SW_READY===true||tries>100){clearInterval(timer);apply();}},50);
    }else{apply();}
    return Promise.resolve({ok:true});
  },
  shot_save:function(_chname,b64data){
    try{var img=document.createElement('img');img.src=b64data;img.onload=function(){var c=document.createElement('canvas');c.width=img.naturalWidth||1280;c.height=img.naturalHeight||720;c.getContext('2d').drawImage(img,0,0);var a=document.createElement('a');a.download=(chname||'直播')+'_'+Date.now()+'.png';a.href=c.toDataURL();a.click();};}catch(e){}
    return Promise.resolve({ok:true});
  },
  fullscreen_toggle:function(){try{var e=document.documentElement;if(e.requestFullscreen)e.requestFullscreen();else if(e.webkitRequestFullscreen)e.webkitRequestFullscreen();}catch(ex){}return Promise.resolve({ok:true,fullscreen:false});},
  get_save_dirs:function(){return Promise.resolve({ok:true,rec:'/storage/emulated/0/Download/LPTV/录制',shot:'/storage/emulated/0/Download/LPTV/截图'});}
};
loadChannels();loadState();
})();
