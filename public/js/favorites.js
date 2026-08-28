/**
 * public/js/favorites.js — Per-user, per-entity favorites stored in localStorage.
 *
 * Used by blocks, subnets, and assets pages to let the user pin rows to the top.
 *
 * A page may OVERRIDE one entity's storage with `registerFavoritesProvider` —
 * the Assets page does, because a favorite there belongs to the VIEW TAB the
 * operator is on (server-persisted per tab, so it follows them across browsers)
 * rather than to this browser. Every consumer (starCellHTML, isFavorite,
 * sortFavoritesFirst, the ?favoriteIds= query builder) goes through
 * getFavorites/toggleFavorite, so registering is the whole integration; nothing
 * else in the page changes. `getStoredFavorites` is the way back to the raw
 * localStorage set, which is what lets a provider SEED itself from the
 * pre-provider per-user set exactly once.
 */

var _favoritesCache = {};
// entity → { get():Set, toggle(id):bool, titleFor?(id, isFav):string }
var _favoritesProviders = {};

function _favoritesKey(entity) {
  return "polaris-favs-" + entity + "-" + (currentUsername || "anon");
}

/** Take over (or, with a falsy provider, release) one entity's storage. */
function registerFavoritesProvider(entity, provider) {
  if (!entity) return;
  if (!provider) delete _favoritesProviders[entity];
  else _favoritesProviders[entity] = provider;
}

function _favoritesProvider(entity) {
  var p = _favoritesProviders[entity];
  return p && typeof p.get === "function" && typeof p.toggle === "function" ? p : null;
}

function getFavorites(entity) {
  var p = _favoritesProvider(entity);
  if (p) return p.get() || new Set();
  return getStoredFavorites(entity);
}

/** This browser's localStorage set for an entity, ignoring any provider. */
function getStoredFavorites(entity) {
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
  var p = _favoritesProvider(entity);
  if (p) return !!p.toggle(id);
  var s = getStoredFavorites(entity);
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
  // A provider may name the scope it stores in — the star is the moment to say
  // "this view tab only", since the next tab shows a different set.
  var prov = _favoritesProvider(entity);
  var title = prov && typeof prov.titleFor === "function"
    ? prov.titleFor(id, fav)
    : (fav ? "Unfavorite" : "Favorite");
  // Escaped HERE, not in the provider: a titleFor may quote an operator-typed
  // name (the Assets tab's), and a lone quote in it would end the attribute.
  if (typeof escapeHtml === "function") title = escapeHtml(title);
  return '<td class="fav-col">' +
    '<button type="button" class="fav-star' + (fav ? ' fav-on' : '') + '"' +
    ' data-fav-entity="' + entity + '" data-fav-id="' + id + '"' +
    ' title="' + title + '"' +
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
