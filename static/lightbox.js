(() => {
'use strict';

const overlay  = Object.assign(document.createElement('div'), { className: 'lightbox-overlay' });
const inner    = Object.assign(document.createElement('div'), { className: 'lightbox-inner' });
const imgEl    = Object.assign(document.createElement('img'), { className: 'lightbox-img', alt: '' });
const footerEl = Object.assign(document.createElement('div'), { className: 'lightbox-footer' });
inner.append(imgEl, footerEl);
overlay.append(inner);
document.body.append(overlay);

overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

function close() { overlay.classList.remove('is-open'); }

window.openLightbox = function(src, filename, hasJson, onLoad, onDelete) {
  imgEl.src = src;
  footerEl.innerHTML = '';

  const nameEl = Object.assign(document.createElement('span'),
    { className: 'lightbox-filename', textContent: filename });
  footerEl.append(nameEl);

  if (hasJson) {
    const btnLoad = Object.assign(document.createElement('button'),
      { className: 'btn-gallery-load', textContent: 'Parameter laden' });
    btnLoad.addEventListener('click', () => { close(); onLoad(); });
    footerEl.append(btnLoad);
  }

  const btnDel = Object.assign(document.createElement('button'),
    { className: 'btn-gallery-delete', textContent: '🗑 Löschen' });
  btnDel.addEventListener('click', () => { close(); onDelete(); });
  footerEl.append(btnDel);

  overlay.classList.add('is-open');
};

})();
