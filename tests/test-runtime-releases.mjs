import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { fixture } from "./helpers.mjs";
import { settings } from "../scripts/common.mjs";
import { zip } from "../scripts/archives.mjs";
import { sha256 } from "../scripts/project_paths.mjs";
import { SPECS, platform_build, check_updates, list_versions, ensure_installed, update_component, artifact, read_json } from "../scripts/runtime.mjs";

function download(component) {
  if (component === "bsl-ls") return zip({ "META-INF/MANIFEST.MF": Buffer.from("fixture") });
  const build = platform_build();
  if (build.format === "zip") return zip({ [build.executable]: Buffer.from("fixture") });
  const header = Buffer.alloc(512);
  header.write(build.executable); header.write("00000000007\0", 124);
  header.fill(32, 148, 156); header.write("0", 156);
  header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return gzipSync(Buffer.concat([header, Buffer.from("fixture"), Buffer.alloc(505), Buffer.alloc(1024)]));
}

function releases(component) {
  const bytes = download(component), base = `https://api.github.com/repos/${SPECS[component]}/releases`;
  const release = (tag, prerelease = false, draft = false) => ({ tag_name: tag, prerelease, draft, assets: [{
    name: component === "bsl-ls" ? `bsl-language-server-${tag.slice(1)}-exec.jar` : platform_build().asset,
    digest: "sha256:" + sha256(bytes), size: bytes.length,
    browser_download_url: `https://github.com/${SPECS[component]}/releases/download/${tag}/artifact`,
  }] });
  const stable = release("v1.0.7"), preview = release("v1.1.0-rc.7", true), urls = [], downloads = [];
  return { stable, preview, release, urls, downloads, io: {
    fetch_json: async url => {
      urls.push(url);
      if (url === base + "/latest") return stable;
      if (url === base + "?per_page=100") return [release("v9.0.0", true, true), preview, stable];
      if (url === base + "/tags/v1.1.0-rc.7") return preview;
      throw new Error("Unexpected release URL: " + url);
    },
    fetch: async url => { downloads.push(url); return new Response(bytes); },
  } };
}

for (const component of ["code-index", "bsl-ls"]) {
  test(`${component}: the version catalog follows every page and sorts by publication date, including prereleases`, async () => {
    const releases=Array.from({length:201},(_,i)=>({tag_name:`v1.0.${i}`,published_at:new Date(Date.UTC(2026,0,1)+i*86400000).toISOString()}));
    releases.push({tag_name:"v0.1.0",published_at:"2026-10-20T00:00:00Z"},{tag_name:"v2.0.0-rc.7",prerelease:true,published_at:"2026-10-19T00:00:00Z"},
      {tag_name:"v1.0.0",published_at:"2020-01-01T00:00:00Z"},{tag_name:"v9.0.0",draft:true},{tag_name:"../bad"},null);
    const urls=[],result=await list_versions(component,{fetch_json:async(url,timeout)=>{urls.push(url);assert.ok(timeout>0&&timeout<=30000);const page=Number(new URL(url).searchParams.get("page"));return releases.slice((page-1)*100,page*100);}});
    assert.equal(result.component,component);assert.equal(result.versions.length,203);assert.equal(urls.length,3);
    assert.ok(urls.every(url=>url.startsWith(`https://api.github.com/repos/${SPECS[component]}/releases?per_page=100&page=`)));
    assert.deepEqual(result.versions.slice(0,3).map(item=>item.version),["v0.1.0","v2.0.0-rc.7","v1.0.200"]);
    assert.equal(result.versions[1].prerelease,true);assert.equal(result.versions.at(-1).publishedAt,"2026-01-01T00:00:00.000Z");
  });

  test(`${component}: a failed later catalog page is reported instead of returning a partial list`, async () => {
    let pages=0;
    await assert.rejects(list_versions(component,{fetch_json:async()=>{if(++pages===1)return Array.from({length:100},(_,i)=>({tag_name:`v1.0.${i}`}));throw new Error("rate limited");}}),/rate limited/);
    await assert.rejects(list_versions(component,{fetch_json:async()=>({tag_name:"v1.0.0"})}),/Invalid runtime release list/);
  });

  for (const mode of ["default stable", "allow prereleases", "exact prerelease", "exact prerelease without v"]) {
    test(`${component}: check and download agree for ${mode}`, async t => {
      const f = fixture(t), config = settings(), options = config.mcp.managed[component], r = releases(component);
      options.enabled = true;
      assert.equal(options.allow_prerelease, false);
      if (mode === "allow prereleases") options.allow_prerelease = true;
      if (mode.startsWith("exact")) options.version = mode.endsWith("without v") ? "1.1.0-rc.7" : "v1.1.0-rc.7";
      const expected = mode === "default stable" ? r.stable : r.preview;
      const checked = await check_updates(f.state, config, component, r.io);
      assert.equal(checked.latest, expected.tag_name);
      assert.equal(checked.state, "update_available");
      assert.equal(r.downloads.length, 0);
      const selectedURL = r.urls[0];
      const file = await ensure_installed(f.state, config, component, false, r.io);
      assert.deepEqual(r.urls, [selectedURL, selectedURL]);
      assert.equal(artifact(f.state, component), file);
      assert.equal(r.downloads[0], expected.assets[0].browser_download_url);
      assert.equal(read_json(path.join(f.state, "runtime-lock.json"))[component].release, expected.tag_name);
      r.urls.length = 0;
      assert.equal(await ensure_installed(f.state, config, component, false, r.io), file);
      assert.deepEqual(r.urls, []); // active artifacts remain immutable/offline until explicit update
      assert.equal((await check_updates(f.state, config, component, r.io)).state, "current");
    });
  }

  for (const kind of ["stable endpoint prerelease", "draft", "all drafts", "wrong tag", "invalid release list"]) {
    test(`${component}: rejects ${kind} before downloading`, async t => {
      const f = fixture(t), config = settings(), options = config.mcp.managed[component], r = releases(component);
      options.enabled = true;
      let response = r.preview;
      if (kind === "draft") response = { ...r.stable, draft: true };
      if (kind === "all drafts") { options.allow_prerelease = true; response = [{ ...r.preview, draft: true }]; }
      if (kind === "wrong tag") options.version = "v9.0.0";
      if (kind === "invalid release list") options.allow_prerelease = true;
      const io = { ...r.io, fetch_json: async () => response };
      await assert.rejects(check_updates(f.state, config, component, io));
      await assert.rejects(ensure_installed(f.state, config, component, false, io));
      assert.deepEqual(r.downloads, []);
      assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
    });
  }

  test(`${component}: changing the release policy stages a candidate and retains the active artifact`, async t => {
    const f = fixture(t), config = settings(), options = config.mcp.managed[component], r = releases(component);
    options.enabled = true;
    const active = await ensure_installed(f.state, config, component, false, r.io);
    options.allow_prerelease = true;
    assert.equal((await check_updates(f.state, config, component, r.io)).latest, r.preview.tag_name);
    const candidate = await ensure_installed(f.state, config, component, true, r.io, { stage: true });
    assert.notEqual(candidate, active);
    assert.equal(artifact(f.state, component), active);
    assert.equal(artifact(f.state, component, "candidate"), candidate);
    options.allow_prerelease = false;
    assert.equal((await check_updates(f.state, config, component, r.io)).latest, r.stable.tag_name);
  });

  test(`${component}: an old candidate cannot bypass a new stable-only or pinned-version selection`, async t => {
    const f = fixture(t), config = settings(), options = config.mcp.managed[component], r = releases(component);
    options.enabled = true;
    const active = await ensure_installed(f.state, config, component, false, r.io);
    options.allow_prerelease = true;
    await ensure_installed(f.state, config, component, true, r.io, { stage: true });
    let launched = false;
    const io = { smoke: async () => { launched = true; return { status: "mcp_ready" }; } };
    options.allow_prerelease = false;
    await assert.rejects(update_component(f.state, config, f.root, f.profile, component, "apply", io), /current release settings/);
    options.version = "v9.0.0";
    await assert.rejects(update_component(f.state, config, f.root, f.profile, component, "apply", io), /current release settings/);
    assert.equal(launched, false);
    assert.equal(artifact(f.state, component), active);
  });
}
