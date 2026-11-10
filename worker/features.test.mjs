import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [store, skins, badges, app, html, masterSite, adminRequestSite, adminRequestScript, worker, wrangler] = await Promise.all([
  readFile(new URL("../data/store.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/skins.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/badges.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../js/app.js", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../SITES/master.html", import.meta.url), "utf8"),
  readFile(new URL("../SITES/request-admin.html", import.meta.url), "utf8"),
  readFile(new URL("../SITES/request-admin.js", import.meta.url), "utf8"),
  readFile(new URL("./index.js", import.meta.url), "utf8"),
  readFile(new URL("./wrangler.toml", import.meta.url), "utf8")
]);

test("the diamond shop sells the three requested skins at their configured prices", () => {
  assert.deepEqual(store.diamondSkins.map(({ category, skinId, priceDiamonds }) =>
    [category, skinId, priceDiamonds]), [
    ["ship", "ship-neon-pink", 750],
    ["shield", "shield-gray-dark", 450],
    ["shot", "shot-led", 500]
  ]);
  assert.ok(skins.categories.ship.some((skin) => skin.id === "ship-neon-pink"));
  assert.ok(skins.categories.shield.some((skin) => skin.id === "shield-gray-dark"));
  assert.ok(skins.categories.shot.some((skin) => skin.id === "shot-led" && skin.shape === "led"));
  assert.match(app, /function purchaseDiamondSkin\(\)/);
  assert.match(app, /context\.arc\(bullet\.x, bullet\.y - point \* 5, 2/);
});

test("the six donor and administrator badges have the requested criteria and rarities", () => {
  const addedBadges = badges.badges.filter((badge) => [
    "admin-account", "kind-donor", "extremely-kind-donor", "partner", "kind-partner",
    "extremely-kind-partner"
  ].includes(badge.id));
  assert.equal(addedBadges.length, 6);
  assert.equal(addedBadges.find((badge) => badge.id === "admin-account").secret, true);
  assert.equal(addedBadges.find((badge) => badge.id === "admin-account").rgb, true);
  assert.deepEqual(addedBadges.map(({ id, rarity }) => [id, rarity]), [
    ["admin-account", "legendary"],
    ["kind-donor", "uncommon"],
    ["extremely-kind-donor", "rare"],
    ["partner", "epic"],
    ["kind-partner", "epic"],
    ["extremely-kind-partner", "legendary"]
  ]);
  assert.match(app, /friendResourceGiftCount >= 5/);
  assert.match(app, /friendResourceGiftCount >= 15/);
  assert.match(app, /friendPassGiftCount >= 15/);
});

test("the December Special Box catalog has valid exact odds and rewards", () => {
  const box = store.specialLootBox;
  const skinsOdds = box.skinIds.length * box.skinOdds;
  const coinsOdds = box.coinRewards.reduce((total, reward) => total + reward.odds, 0);

  assert.equal(box.title["pt-BR"], "Inicial Box Especial!");
  assert.equal(box.priceDiamonds, 1000);
  assert.equal(skinsOdds, 12.4);
  assert.equal(coinsOdds, 87.6);
  assert.equal(skinsOdds + coinsOdds, 100);
  assert.deepEqual(box.coinRewards.map(({ amount, odds }) => [amount, odds]), [
    [100, 25],
    [500, 20],
    [1000, 15],
    [2500, 10],
    [5000, 7],
    [10000, 5],
    [25000, 3],
    [50000, 2.3],
    [100000, 0.3]
  ]);
  assert.ok(box.skinIds.every((skinId) => skins.categories.ship.find((skin) => skin.id === skinId).rarity === "special"));
  assert.equal(skins.rarities.special.color.toLowerCase(), "#f8fbff");
  assert.equal(Date.parse(box.startsAt), Date.parse("2026-12-08T00:00:00-03:00"));
  assert.equal(Date.parse(box.endsAt), Date.parse("2026-12-25T00:00:00-03:00"));
  for (const skinId of box.skinIds) {
    assert.ok(skins.categories.ship.some((skin) => skin.id === skinId && skin.rarity === "special"));
  }
});

test("the four-skin Special Box stays hidden outside its December 8–24 window", () => {
  const renderSpecialLootBox = app.slice(
    app.indexOf("function renderSpecialLootBox()"),
    app.indexOf("function STARTING_ABILITY_PRICES")
  );

  assert.match(html, /<article class="special-box-card" id="special-box-card" hidden>/);
  assert.match(renderSpecialLootBox, /const active = specialBoxIsActive\(\);\s*\$\("#special-box-card"\)\.hidden = !active;/);
});

test("special ship abilities are wired to the game and expose the H control", () => {
  const requiredIds = [
    "ship-special-flame",
    "ship-special-ice",
    "ship-special-void",
    "ship-special-explosive"
  ];
  assert.deepEqual(
    skins.categories.ship.filter((skin) => skin.rarity === "special").map((skin) => skin.id),
    requiredIds
  );
  assert.match(app, /const SPECIAL_SHIP_ABILITIES = \{/);
  assert.match(app, /"ship-special-flame": \{ id: "flame", duration: 190, cost: 4/);
  assert.match(app, /"ship-special-ice": \{ id: "ice", duration: 120, cost: 0/);
  assert.match(app, /"ship-special-void": \{ id: "void", duration: 30, cost: 2/);
  assert.match(app, /"ship-special-explosive": \{ id: "explosive", duration: 200, cost: 1/);
  assert.match(app, /function selectedSpecialAbility\(\)/);
  assert.match(app, /function useSpecialAbility\(\)/);
  assert.match(app, /specialLifePenalty = specialAbility\?\.id === "flame" \? 1/);
  assert.match(app, /specialAbility\?\.id === "ice" \? 4/);
  assert.match(app, /game\.boss\.maxHealth \* 0\.75/);
  assert.match(app, /game\.boss\.maxHealth \* 0\.5/);
  assert.match(app, /game\.iceFrozenUntil = game\.elapsed \+ 50/);
  assert.match(app, /selectedSkins\.ship === "ship-special-ice" \? 3 : 0/);
  assert.match(app, /upgradeValue\("hull"\) <= 4/);
  assert.match(app, /game\.bossesDefeated < 2/);
  assert.match(app, /event\.code === "KeyH"/);
  assert.match(html, /id="special-ability-button"/);
});

test("master access code stays outside promo JSON and admin request pages are embedded", () => {
  assert.match(app, /\/api\/master\/verify-code/);
  assert.match(html, /id="game-site-frame"/);
  assert.match(html, /id="open-admin-request-site"/);
  assert.equal((html.match(/id="open-admin-request-site"/g) || []).length, 1);
  assert.match(html, /id="screen-settings"[\s\S]*id="open-admin-request-site"/);
  assert.match(masterSite, /id="master-password"/);
  assert.match(adminRequestSite, /id="request-form"/);
  assert.match(adminRequestScript, /api\/admin\/requests/);
  assert.match(worker, /url\.pathname === "\/api\/admin\/requests" \|\| url\.pathname === "\/api\/adm\/requests"/);
  assert.match(wrangler, /127\.0\.0\.1:8765/);
  assert.match(wrangler, /localhost:5500/);
  assert.match(html, /settings-version[\s\S]*1\.0\.14/);
  assert.match(html, /id="open-master-panel"/);
  assert.match(app, /openGameSite\("SITES\/master\.html"\)/);
  assert.match(masterSite, /Senha mestre/);
  assert.match(worker, /async function masterLogin/);
  assert.match(worker, /ACCOUNT_SPECIAL_CODE/);
  assert.match(worker, /adminApprovedAt \+ 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(worker, /recipients\.size > 5/);
  assert.match(worker, /now - 24 \* 60 \* 60 \* 1000/);
  assert.match(app, /LOCAL_MIGRATION_GRACE_MS = 3 \* 24 \* 60 \* 60 \* 1000/);
});
