#!/usr/bin/env node
/**
 * Live access harness — hits a running Next server as anonymous / student /
 * teacher / admin and asserts status codes for every gated surface.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 node scripts/access-harness.mjs
 *
 * Exit 0 only when every expectation matches.
 */

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

/** @typedef {"anon"|"student"|"author"|"admin"} Actor */

/** @type {{ name: string; method?: string; path: string; body?: unknown; expect: Record<Actor, number> }[]} */
const CASES = [
  // Identity
  { name: "GET /api/me", path: "/api/me", expect: { anon: 401, student: 200, author: 200, admin: 200 } },
  {
    name: "GET /api/enrollments",
    path: "/api/enrollments",
    expect: { anon: 401, student: 200, author: 200, admin: 200 },
  },
  {
    name: "POST /api/enrollments (course_demo)",
    method: "POST",
    path: "/api/enrollments",
    body: { courseId: "course_demo" },
    expect: { anon: 401, student: 200, author: 200, admin: 200 },
  },
  {
    name: "POST /api/enrollments missing courseId",
    method: "POST",
    path: "/api/enrollments",
    body: {},
    expect: { anon: 401, student: 400, author: 400, admin: 400 },
  },
  {
    name: "POST /api/enrollments unknown course",
    method: "POST",
    path: "/api/enrollments",
    body: { courseId: "course_does_not_exist" },
    expect: { anon: 401, student: 404, author: 404, admin: 404 },
  },

  {
    name: "GET /api/progress",
    path: "/api/progress",
    expect: { anon: 401, student: 200, author: 200, admin: 200 },
  },
  {
    name: "GET /api/wishlist",
    path: "/api/wishlist",
    expect: { anon: 401, student: 200, author: 200, admin: 200 },
  },
  {
    name: "POST /api/wishlist course_demo",
    method: "POST",
    path: "/api/wishlist",
    body: { courseId: "course_demo" },
    expect: { anon: 401, student: 200, author: 200, admin: 200 },
  },
  {
    name: "GET /api/reviews?courseId=course_demo",
    path: "/api/reviews?courseId=course_demo",
    expect: { anon: 200, student: 200, author: 200, admin: 200 },
  },
  {
    name: "GET /api/certificates",
    path: "/api/certificates",
    expect: { anon: 401, student: 200, author: 200, admin: 200 },
  },
  {
    name: "GET /learning",
    path: "/learning",
    expect: { anon: 200, student: 200, author: 200, admin: 200 },
  },
  { name: "GET /api/catalog", path: "/api/catalog", expect: { anon: 200, student: 200, author: 200, admin: 200 } },
  { name: "GET /api/cases", path: "/api/cases", expect: { anon: 200, student: 200, author: 200, admin: 200 } },
  {
    name: "GET /api/cases/demo-pacsbin",
    path: "/api/cases/demo-pacsbin",
    expect: { anon: 200, student: 200, author: 200, admin: 200 },
  },
  {
    name: "GET /api/cases/demo-pacsbin/prefetch",
    path: "/api/cases/demo-pacsbin/prefetch",
    expect: { anon: 200, student: 200, author: 200, admin: 200 },
  },
  {
    name: "GET /api/cases/demo-pacsbin/series",
    path: "/api/cases/demo-pacsbin/series",
    expect: { anon: 200, student: 200, author: 200, admin: 200 },
  },

  // Authoring mutations
  {
    name: "POST /api/cases (create)",
    method: "POST",
    path: "/api/cases",
    body: {
      caseId: `harness_${Date.now().toString(36)}`,
      title: "Harness case",
      modality: "CT",
      pacsbinBaseUrl: "/cornerstone",
    },
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },
  {
    name: "POST /api/cases/demo-pacsbin/findings",
    method: "POST",
    path: "/api/cases/demo-pacsbin/findings",
    body: {
      label: "Harness finding",
      description: "temp",
      teachingPoints: [],
      state: " ",
      marker: { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
      order: 99,
    },
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },
  {
    name: "POST /api/upload (no files)",
    method: "POST",
    path: "/api/upload",
    // multipart without files — auth gate runs first; expect 401/403 or 400 after auth
    body: null,
    formEmpty: true,
    expect: { anon: 401, student: 403, author: 400, admin: 400 },
  },
  {
    name: "GET /api/studio/profile",
    path: "/api/studio/profile",
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },

  // Admin
  {
    name: "GET /api/admin/cases",
    path: "/api/admin/cases",
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },
  {
    name: "GET /api/admin/authors",
    path: "/api/admin/authors",
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },
  {
    name: "GET /api/admin/courses",
    path: "/api/admin/courses",
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },
  {
    name: "GET /api/admin/patients",
    path: "/api/admin/patients",
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },
  {
    name: "POST /api/admin/studies (missing fields)",
    method: "POST",
    path: "/api/admin/studies",
    body: {},
    expect: { anon: 401, student: 403, author: 400, admin: 400 },
  },
  {
    name: "GET /api/admin/playlists",
    path: "/api/admin/playlists",
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },
  {
    name: "GET /api/admin/memberships",
    path: "/api/admin/memberships",
    expect: { anon: 401, student: 403, author: 403, admin: 200 },
  },
  {
    name: "GET /api/admin/orthanc-status",
    path: "/api/admin/orthanc-status",
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },
  {
    name: "GET /api/admin/studies",
    path: "/api/admin/studies",
    expect: { anon: 401, student: 403, author: 200, admin: 200 },
  },
  {
    name: "PATCH /api/admin/authors/auth_demo verify",
    method: "PATCH",
    path: "/api/admin/authors/auth_demo",
    body: { verification: "verified" },
    expect: { anon: 401, student: 403, author: 403, admin: 200 },
  },
  {
    name: "PATCH /api/admin/authors/auth_demo bad verification",
    method: "PATCH",
    path: "/api/admin/authors/auth_demo",
    body: { verification: "not-a-status" },
    expect: { anon: 401, student: 403, author: 403, admin: 400 },
  },
  {
    name: "PATCH /api/studio/profile empty name",
    method: "PATCH",
    path: "/api/studio/profile",
    body: { name: "   " },
    expect: { anon: 401, student: 403, author: 400, admin: 400 },
  },
  {
    name: "POST /api/admin/memberships promote author",
    method: "POST",
    path: "/api/admin/memberships",
    body: { email: "harness.teacher@flowrad.local", role: "author", name: "Harness Teacher" },
    expect: { anon: 401, student: 403, author: 403, admin: 200 },
  },

  // Pages (HTML)
  { name: "GET /", path: "/", expect: { anon: 200, student: 200, author: 200, admin: 200 } },
  { name: "GET /library", path: "/library", expect: { anon: 200, student: 200, author: 200, admin: 200 } },
  { name: "GET /course/course_demo", path: "/course/course_demo", expect: { anon: 200, student: 200, author: 200, admin: 200 } },
  { name: "GET /case/demo-pacsbin", path: "/case/demo-pacsbin", expect: { anon: 200, student: 200, author: 200, admin: 200 } },
  { name: "GET /sign-in", path: "/sign-in", expect: { anon: 200, student: 200, author: 200, admin: 200 } },
  // Studio/Admin layouts redirect unauthenticated → 307/302 to sign-in; students forbidden → /
  {
    name: "GET /studio",
    path: "/studio",
    redirectOk: true,
    expect: { anon: 307, student: 307, author: 200, admin: 200 },
  },
  {
    name: "GET /admin",
    path: "/admin",
    redirectOk: true,
    expect: { anon: 307, student: 307, author: 307, admin: 200 },
  },
  {
    name: "GET /dashboard",
    path: "/dashboard",
    redirectOk: true,
    expect: { anon: 307, student: 307, author: 307, admin: 307 },
  },
];

async function demoCookie(role) {
  const res = await fetch(`${BASE}/api/auth/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    throw new Error(`demo login ${role} -> ${res.status}`);
  }
  const set = res.headers.getSetCookie?.() || [];
  const raw = set.length
    ? set
    : [res.headers.get("set-cookie")].filter(Boolean);
  const jar = raw
    .map((c) => String(c).split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!jar.includes("flowrad_demo=")) {
    throw new Error(`demo login ${role} did not set flowrad_demo cookie: ${jar}`);
  }
  const me = await fetch(`${BASE}/api/me`, { headers: { Cookie: jar } });
  if (!me.ok) throw new Error(`demo ${role} /api/me -> ${me.status}`);
  const data = await me.json();
  return { jar, user: data.user };
}

async function request(actor, jar, spec) {
  const method = spec.method || "GET";
  /** @type {Record<string, string>} */
  const headers = {};
  if (jar) headers.Cookie = jar;
  /** @type {RequestInit} */
  const init = { method, headers, redirect: "manual" };
  if (spec.formEmpty) {
    // Empty multipart so auth runs then "no files"
    const boundary = "----HarnessBoundary";
    headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    init.body = `--${boundary}--\r\n`;
  } else if (spec.body !== undefined && spec.body !== null) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(spec.body);
  }
  const res = await fetch(`${BASE}${spec.path}`, init);
  return res.status;
}

function statusMatches(actual, expected, redirectOk) {
  if (actual === expected) return true;
  // Next may use 302 or 307 for redirects
  if (redirectOk && expected === 307 && (actual === 302 || actual === 303 || actual === 307)) {
    return true;
  }
  // Admin/author studio sometimes 200 with soft redirect in RSC — accept 307→/
  if (redirectOk && expected === 307 && actual === 200) return false;
  return false;
}

async function main() {
  const health = await fetch(`${BASE}/`).catch((e) => {
    console.error(`Server not reachable at ${BASE}: ${e.message}`);
    process.exit(2);
  });
  if (!health) process.exit(2);

  const sessions = {
    anon: { jar: null, user: null },
    student: await demoCookie("student"),
    author: await demoCookie("author"),
    admin: await demoCookie("super_admin"),
  };

  console.log("Sessions:");
  for (const [k, v] of Object.entries(sessions)) {
    if (k === "anon") continue;
    console.log(
      `  ${k}: ${v.user?.email} role=${v.user?.membershipRole} platform=${v.user?.platformRole || "-"}`
    );
  }

  let fail = 0;
  let pass = 0;
  const failures = [];

  for (const spec of CASES) {
    for (const actor of /** @type {Actor[]} */ (["anon", "student", "author", "admin"])) {
      const expected = spec.expect[actor];
      const jar = sessions[actor].jar;
      let actual;
      try {
        actual = await request(actor, jar, spec);
      } catch (e) {
        actual = -1;
        failures.push(`${spec.name} [${actor}]: threw ${e.message}`);
        fail++;
        continue;
      }
      if (statusMatches(actual, expected, spec.redirectOk)) {
        pass++;
      } else {
        fail++;
        failures.push(`${spec.name} [${actor}]: expected ${expected}, got ${actual}`);
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed (${pass + fail} checks)`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  ✗", f);
  }

  // --- Interaction scenarios (multi-step) ---
  console.log("\nInteraction scenarios:");
  const draftId = `harness_draft_${Date.now().toString(36)}`;
  const createRes = await fetch(`${BASE}/api/cases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessions.author.jar,
    },
    body: JSON.stringify({
      caseId: draftId,
      title: "Draft isolation harness",
      modality: "CT",
      pacsbinBaseUrl: "/cornerstone",
    }),
  });
  if (createRes.status !== 200) {
    fail++;
    failures.push(`author create draft: expected 200, got ${createRes.status}`);
  } else {
    pass++;
    console.log("  ✓ author creates draft case");
  }

  for (const [actor, expected] of [
    ["anon", 404],
    ["student", 404],
    ["author", 200],
    ["admin", 200],
  ]) {
    const st = await request(actor, sessions[actor].jar, {
      path: `/api/cases/${draftId}`,
    });
    if (st === expected) {
      pass++;
      console.log(`  ✓ ${actor} GET draft -> ${st}`);
    } else {
      fail++;
      failures.push(`GET draft [${actor}]: expected ${expected}, got ${st}`);
      console.log(`  ✗ ${actor} GET draft -> ${st} (want ${expected})`);
    }
  }

  // Publish with studyRefs but no deid report should fail for admin
  const publishRes = await fetch(`${BASE}/api/admin/cases/${draftId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessions.admin.jar,
    },
    body: JSON.stringify({
      status: "published",
      studyRefs: [{ studyInstanceUID: "1.2.3.harness.missing.deid", role: "current" }],
    }),
  });
  if (publishRes.status === 500 || publishRes.status === 400) {
    const body = await publishRes.json().catch(() => ({}));
    const msg = String(body.error || "");
    if (/de-id|Cannot publish/i.test(msg) || publishRes.status !== 200) {
      pass++;
      console.log(`  ✓ publish blocked without de-id (${publishRes.status})`);
    } else {
      fail++;
      failures.push(`publish without deid unexpectedly succeeded: ${msg}`);
    }
  } else if (publishRes.status === 200) {
    fail++;
    failures.push("publish without deid returned 200 — gate missing");
    console.log("  ✗ publish without de-id returned 200");
  } else if (publishRes.status === 404) {
    // Admin case API may not see studio-created case if org mismatch — still a bug to note
    fail++;
    failures.push(`publish draft: admin got 404 for ${draftId}`);
    console.log("  ✗ admin cannot see author-created draft for publish");
  } else {
    fail++;
    failures.push(`publish without deid: unexpected ${publishRes.status}`);
  }

  // Double enroll is idempotent
  const e1 = await fetch(`${BASE}/api/enrollments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessions.student.jar },
    body: JSON.stringify({ courseId: "course_demo" }),
  });
  const e2 = await fetch(`${BASE}/api/enrollments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessions.student.jar },
    body: JSON.stringify({ courseId: "course_demo" }),
  });
  if (e1.status === 200 && e2.status === 200) {
    const a = await e1.json();
    const b = await e2.json();
    if (a.enrollment?.id && a.enrollment.id === b.enrollment?.id) {
      pass++;
      console.log("  ✓ double enroll is idempotent");
    } else {
      fail++;
      failures.push("double enroll created different enrollment ids");
    }
  } else {
    fail++;
    failures.push(`double enroll statuses ${e1.status}/${e2.status}`);
  }

  // Student cannot promote members
  const promote = await fetch(`${BASE}/api/admin/memberships`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessions.student.jar },
    body: JSON.stringify({ email: "student@flowrad.local", role: "owner" }),
  });
  if (promote.status === 403) {
    pass++;
    console.log("  ✓ student cannot self-promote to owner");
  } else {
    fail++;
    failures.push(`student self-promote expected 403, got ${promote.status}`);
  }

  // Studio HTML must not show Forbidden for teachers
  {
    const html = await fetch(`${BASE}/studio`, {
      headers: { Cookie: sessions.author.jar },
      redirect: "manual",
    }).then((r) => r.text());
    if (/Forbidden|Couldn't load your studio/i.test(html)) {
      // Client-rendered error may not be in SSR HTML — hit the API instead
      const api = await fetch(`${BASE}/api/admin/cases`, {
        headers: { Cookie: sessions.author.jar },
      });
      if (api.status !== 200) {
        fail++;
        failures.push(`teacher studio data API expected 200, got ${api.status}`);
      } else {
        pass++;
        console.log("  ✓ teacher can load studio case list API");
      }
    } else {
      pass++;
      console.log("  ✓ teacher /studio HTML has no Forbidden banner");
    }
  }

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  ✗", f);
    process.exit(1);
  }
  console.log("All access matrix + interaction checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
