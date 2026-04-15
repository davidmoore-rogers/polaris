/**
 * public/js/api.js — Thin fetch wrapper for /api/v1
 */

const API_BASE = "/api/v1";

async function request(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(API_BASE + path, opts);

  if (res.status === 204) return null;
  if (res.status === 401) { window.location.href = "/login.html"; return; }

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

const api = {
  blocks: {
    list:   (params) => request("GET", "/blocks" + toQuery(params)),
    get:    (id)     => request("GET", `/blocks/${id}`),
    create: (body)   => request("POST", "/blocks", body),
    update: (id, b)  => request("PUT", `/blocks/${id}`, b),
    delete: (id)     => request("DELETE", `/blocks/${id}`),
  },
  subnets: {
    list:          (params) => request("GET", "/subnets" + toQuery(params)),
    get:           (id)     => request("GET", `/subnets/${id}`),
    create:        (body)   => request("POST", "/subnets", body),
    nextAvailable: (body)   => request("POST", "/subnets/next-available", body),
    update:        (id, b)  => request("PUT", `/subnets/${id}`, b),
    delete:        (id)     => request("DELETE", `/subnets/${id}`),
  },
  reservations: {
    list:    (params) => request("GET", "/reservations" + toQuery(params)),
    get:     (id)     => request("GET", `/reservations/${id}`),
    create:  (body)   => request("POST", "/reservations", body),
    update:  (id, b)  => request("PUT", `/reservations/${id}`, b),
    release: (id)     => request("DELETE", `/reservations/${id}`),
  },
  utilization: {
    global:  ()   => request("GET", "/utilization"),
    block:   (id) => request("GET", `/utilization/blocks/${id}`),
    subnet:  (id) => request("GET", `/utilization/subnets/${id}`),
  },
  users: {
    list:          ()       => request("GET", "/users"),
    create:        (body)   => request("POST", "/users", body),
    resetPassword: (id, b)  => request("PUT", `/users/${id}/password`, b),
    delete:        (id)     => request("DELETE", `/users/${id}`),
  },
};

function toQuery(params) {
  if (!params) return "";
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? "?" + qs : "";
}
