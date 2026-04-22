/**
 * public/js/favorites.js — Per-user, per-entity favorites stored in localStorage.
 *
 * Used by blocks, subnets, and assets pages to let the user pin rows to the top.
 */

var _favoritesCache = {};

function _favoritesKey(entity) {
  return "shelob-favs-" + entity + "-" + (currentUsername || "anon");
}

function getFavorites(entity) {
  var key = _favoritesKey(entity);
  if (_favoritesCache[key]) return _favoritesCache[key];
  var set = new Set();
  try {
    var raw = localStorage.getItem(key);
    if (raw) JSON.parse(raw).forEach(function (id) { set.add(id); });
  } catch (_) {}
  _favoritesCache[key] = set;
  return set;
}

function isFavorite(entity, id) {
  return getFavorites(entity).has(id);
}

function toggleFavorite(entity, id) {
  var s = getFavorites(entity);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  try {
    localStorage.setItem(_favoritesKey(entity), JSON.stringify(Array.from(s)));
  } catch (_) {}
  _favoritesCache[_favoritesKey(entity)] = s;
  return s.has(id);
}

function starCellHTML(entity, id) {
  var fav = isFavorite(entity, id);
  return '<td class="fav-col">' +
    '<button type="button" class="fav-star' + (fav ? ' fav-on' : '') + '"' +
    ' data-fav-entity="' + entity + '" data-fav-id="' + id + '"' +
    ' title="' + (fav ? 'Unfavorite' : 'Favorite') + '"' +
    ' aria-label="Toggle favorite">' + (fav ? '★' : '☆') + '</button>' +
    '</td>';
}

function sortFavoritesFirst(data, entity) {
  var favs = getFavorites(entity);
  if (!favs.size) return data;
  var favRows = [];
  var rest = [];
  data.forEach(function (row) {
    if (favs.has(row.id)) favRows.push(row);
    else rest.push(row);
  });
  return favRows.concat(rest);
}

/**
 * Wire favorite-star clicks inside a table body. Calls `onChange()` after each toggle.
 * Safe to call multiple times — uses a single delegated listener per tbody.
 */
function wireFavoriteClicks(tbodyId, onChange) {
  var tbody = document.getElementById(tbodyId);
  if (!tbody || tbody._favWired) return;
  tbody._favWired = true;
  tbody.addEventListener("click", function (e) {
    var btn = e.target.closest(".fav-star");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var entity = btn.getAttribute("data-fav-entity");
    var id = btn.getAttribute("data-fav-id");
    if (!entity || !id) return;
    toggleFavorite(entity, id);
    if (typeof onChange === "function") onChange();
  });
}
