"use strict";(function(){if(!document.head.querySelector("[data-reference=treb]")){var script=document.querySelector("script[data-treb]");if(script){var base=(script.src||"").replace(/[^/]+\.js[^/]*?$/i,"");script=document.createElement("script");script.setAttribute("type","module");script.setAttribute("data-reference","treb");script.setAttribute("src",base+"treb-bundle.js");document.head.appendChild(script)}}var scripts=document.querySelectorAll("script[data-treb]");if(scripts){for(var i=0;i<scripts.length;i++){var script=scripts[i];if(script.parentElement){var div=document.createElement("div");for(var key in script.dataset){div.dataset[key]=script.dataset[key]}for(var _i=0,_a=["class","style"];_i<_a.length;_i++){var key=_a[_i];var value=script.getAttribute(key);if(value){div.setAttribute(key,value)}}script.parentElement.replaceChild(div,script)}}}})();
