import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const [store, skins, badges, events, battlePass, app, html, masterSite, adminRequestSite, adminRequestScript, worker, wrangler, weeklyCompetitionSource] = await Promise.all([
  readFile(new URL("../data/store.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/skins.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/badges.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/events.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/battle-pass.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../js/app.js", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../SITES/master.html", import.meta.url), "utf8"),
  readFile(new URL("../SITES/request-admin.html", import.meta.url), "utf8"),
  readFile(new URL("../SITES/request-admin.js", import.meta.url), "utf8"),
  readFile(new URL("./index.js", import.meta.url), "utf8"),
  readFile(new URL("./wrangler.toml", import.meta.url), "utf8"),
  readFile(new URL("../js/weekly-competition.js", import.meta.url), "utf8")
]);

const weeklyCompetitionContext = {};
runInNewContext(weeklyCompetitionSource, weeklyCompetitionContext);
const weeklyCompetition = weeklyCompetitionContext.WeeklyCompetition;

test("the weekly AI race opens Sundays at 10 in Sao Paulo and advances rival scores", () => {
  const beforeFirstRace = weeklyCompetition.currentWindow(Date.parse("2026-11-15T12:59:59Z"));
  assert.equal(beforeFirstRace.weekId, "2026-11-15");
  assert.equal(beforeFirstRace.weekNumber, 1);
  assert.equal(beforeFirstRace.startAt, Date.parse("2026-11-15T13:00:00Z"));

  const firstRace = weeklyCompetition.currentWindow(Date.parse("2026-11-15T13:00:00Z"));
  assert.equal(firstRace.weekNumber, 1);
  assert.equal(firstRace.endAt, Date.parse("2026-11-22T13:00:00Z"));
  assert.equal(weeklyCompetition.currentWindow(firstRace.endAt).weekNumber, 2);

  const noScoreRivals = weeklyCompetition.aiScores({ progress: 1 });
  assert.deepEqual([...noScoreRivals], [2000, 4500, 8000, 15000, 50000]);
  const activeRivals = weeklyCompetition.aiScores({
    weeklyScore: 20000,
    bestScore: 50000,
    progress: 0.5
  });
  assert.ok(activeRivals.some((score) => score > 20000));
  assert.deepEqual(
    [...weeklyCompetition.aiScores({ progress: 0.5, previousScores: noScoreRivals })],
    [...noScoreRivals]
  );
});

test("the 40-level Neon Pass preserves existing rewards and adds timed trials, charges, coins, and gold", () => {
  const validationSource = app.slice(
    app.indexOf("function validateBattlePassData("),
    app.indexOf("function validateEventData(")
  );
  const validationContext = {
    skinData: skins,
    skinCategories: ["ship", "shield", "shot"],
    STARTING_ABILITIES: [{ id: "triple" }, { id: "shield" }, { id: "extra-lives" }],
    BATTLE_PASS_TRIAL_SKIN_IDS: new Set([
      "shot-candy-cane", "shield-christmas-lights", "ship-christmas-tree"
    ]),
    findSkin(skinId) {
      return Object.values(skins.categories).flat().find((skin) => skin.id === skinId);
    }
  };
  runInNewContext(`${validationSource}\nglobalThis.validateBattlePassData = validateBattlePassData;`, validationContext);
  validationContext.validateBattlePassData(JSON.parse(JSON.stringify(battlePass)));

  assert.equal(battlePass.levels.length, 40);
  assert.equal(battlePass.levelRequirements.length, 40);
  assert.ok(battlePass.levelRequirements.slice(30).every((count) => count === 25));
  const premiumSkins = battlePass.levels.slice(0, 30).flatMap((level) => level.premium)
    .filter((reward) => reward.type === "skin").map(({ skinId }) => skinId);
  for (const skinId of ["shot-candy-cane", "shield-christmas-lights", "ship-christmas-tree"]) {
    assert.ok(premiumSkins.includes(skinId));
  }
  for (const track of ["free", "premium"]) {
    const originalRewards = battlePass.levels.slice(0, 30).flatMap((level) => level[track])
      .filter((reward) => reward.type !== "skin-trial" && reward.type !== "name-color");
    for (const [type, count] of Object.entries({ drop: 10, charge: 5, coins: 5, empty: 5 })) {
      assert.equal(originalRewards.filter((reward) => reward.type === type).length, count);
    }
  }
  for (const [levelNumber, skinId] of [
    [5, "shot-candy-cane"],
    [15, "shield-christmas-lights"],
    [35, "ship-christmas-tree"]
  ]) {
    assert.ok(battlePass.levels[levelNumber - 1].free.some((reward) =>
      reward.type === "skin-trial" && reward.skinId === skinId && reward.durationDays === 14));
  }
  assert.ok(battlePass.levels[24].premium.some((reward) =>
    reward.type === "name-color" && reward.color === "gold"));
  assert.deepEqual(
    ["free", "premium"].map((track) =>
      battlePass.levels[38][track].find((reward) => reward.type === "coins")?.amount),
    [10000, 10000]
  );
  assert.deepEqual(
    battlePass.levels.slice(31, 40).flatMap((level) =>
      ["free", "premium"].flatMap((track) => level[track]
        .filter((reward) => reward.type === "starting-charge")
        .map(({ abilityId, amount }) => [abilityId, amount]))),
    [
      ["triple", 2], ["triple", 2],
      ["shield", 1], ["shield", 1],
      ["extra-lives", 2], ["extra-lives", 2],
      ["triple", 1], ["triple", 1]
    ]
  );
  assert.match(app, /clamp\(savedBattlePass\.level, 1, maximumPassLevel\)/);
  assert.match(app, /function expireSkinTrials\(\)/);
  assert.match(app, /function selectNameColor\(color\)/);
  assert.match(html, /id="profile-name-colors"/);
  assert.match(worker, /function publicNameColor\(profile\)/);

  const nameColorsSource = app.slice(
    app.indexOf("const NAME_COLORS ="),
    app.indexOf("const DEFAULT_NAME_COLORS =")
  );
  const nameColorsContext = {};
  runInNewContext(`${nameColorsSource}\nglobalThis.NAME_COLORS = NAME_COLORS;`, nameColorsContext);
  assert.deepEqual(
    Object.entries(nameColorsContext.NAME_COLORS).filter(([, color]) => color.price > 0)
      .map(([name, color]) => [name, color.price]),
    [["purple", 1000], ["green", 1000], ["yellow", 1000], ["blue", 1000]]
  );
});

test("temporary skins expire, while name-color purchases charge the wallet only once", () => {
  const skinAccessSource = app.slice(
    app.indexOf("function hasSkinAccess("),
    app.indexOf("function expireSkinTrials(")
  );
  const skinAccessContext = { Date: { now: () => 1000 } };
  runInNewContext(`${skinAccessSource}\nglobalThis.hasSkinAccess = hasSkinAccess;`, skinAccessContext);
  assert.equal(skinAccessContext.hasSkinAccess({
    ownedSkins: [],
    trialSkinExpiresAt: { "shot-candy-cane": 1001 }
  }, "shot-candy-cane"), true);
  assert.equal(skinAccessContext.hasSkinAccess({
    ownedSkins: [],
    trialSkinExpiresAt: { "shot-candy-cane": 1000 }
  }, "shot-candy-cane"), false);
  assert.equal(skinAccessContext.hasSkinAccess({
    ownedSkins: ["shot-candy-cane"],
    trialSkinExpiresAt: {}
  }, "shot-candy-cane"), true);

  const purchaseSource = app.slice(
    app.indexOf("function selectNameColor("),
    app.indexOf("function renderOwnResources(")
  );
  const purchaseContext = {
    NAME_COLORS: {
      black: { price: 0 },
      white: { price: 0 },
      gray: { price: 0 },
      purple: { price: 1000 },
      yellow: { price: 1000 },
      gold: { price: 0 }
    },
    account: {
      coins: 1500,
      ownedNameColors: ["black", "white", "gray"],
      nameColor: "gray",
      battlePass: { premium: false, premiumClaimed: [] }
    },
    t: (key) => key,
    showToast: () => {}
  };
  purchaseContext.persistAccount = (nextAccount) => { purchaseContext.account = nextAccount; };
  runInNewContext(`${purchaseSource}\nglobalThis.selectNameColor = selectNameColor;`, purchaseContext);
  purchaseContext.selectNameColor("purple");
  assert.equal(purchaseContext.account.coins, 500);
  assert.equal(purchaseContext.account.nameColor, "purple");
  purchaseContext.selectNameColor("purple");
  assert.equal(purchaseContext.account.coins, 500);
  purchaseContext.selectNameColor("yellow");
  assert.equal(purchaseContext.account.coins, 500);

  const profileNameColorSource = worker.slice(
    worker.indexOf("const PUBLIC_NAME_COLORS"),
    worker.indexOf("function publicProfile(")
  );
  const profileNameColorContext = {};
  runInNewContext(`${profileNameColorSource}\nglobalThis.publicNameColor = publicNameColor;`, profileNameColorContext);
  assert.equal(profileNameColorContext.publicNameColor({
    nameColor: "purple",
    state: { ownedNameColors: ["purple"] }
  }), "purple");
  assert.equal(profileNameColorContext.publicNameColor({
    nameColor: "purple",
    state: { ownedNameColors: [] }
  }), "gray");
  assert.equal(profileNameColorContext.publicNameColor({
    nameColor: "gold",
    state: { battlePass: { premium: true, premiumClaimed: [25] } }
  }), "gold");
  assert.equal(profileNameColorContext.publicNameColor({
    nameColor: "gold",
    state: { battlePass: { premium: false, premiumClaimed: [25] } }
  }), "gray");
});

test("battle-pass rewards apply trial expirations, starting charges, and premium name colors", () => {
  const rewardSource = app.slice(
    app.indexOf("function applyBattlePassRewardsToLevel("),
    app.indexOf("function grantBattlePassRewardsThrough(")
  );
  const rewardContext = {
    battlePassData: battlePass,
    STARTING_ABILITIES: [
      { id: "triple" },
      { id: "shield" },
      { id: "extra-lives" }
    ],
    t: (key) => key,
    Date: { now: () => 1000 },
    addVaultItem(nextAccount, type) {
      return {
        account: {
          ...nextAccount,
          vaultItems: [...(nextAccount.vaultItems || []), { type }]
        }
      };
    }
  };
  runInNewContext(`${rewardSource}\nglobalThis.applyBattlePassRewardsToLevel = applyBattlePassRewardsToLevel;`, rewardContext);
  const createAccount = () => ({
    coins: 0,
    ownedSkins: [],
    ownedNameColors: ["black", "white", "gray"],
    trialSkinExpiresAt: {},
    vaultItems: [],
    battlePass: {
      freeClaimed: [],
      premiumClaimed: [],
      premium: true,
      abilityCharges: 0,
      startingAbilityCharges: { triple: 0, shield: 0, "extra-lives": 0 },
      treeLevel: 0
    }
  });
  const trial = rewardContext.applyBattlePassRewardsToLevel(createAccount(), 5, "free");
  assert.equal(trial.trialSkinExpiresAt["shot-candy-cane"], 1000 + 14 * 24 * 60 * 60 * 1000);
  assert.equal(trial.vaultItems.length, 1);
  const charges = rewardContext.applyBattlePassRewardsToLevel(createAccount(), 32, "free");
  assert.equal(charges.battlePass.startingAbilityCharges.triple, 2);
  const gold = rewardContext.applyBattlePassRewardsToLevel(createAccount(), 25, "premium");
  assert.ok(gold.ownedNameColors.includes("gold"));
  assert.ok(gold.battlePass.premiumClaimed.includes(25));
});

test("the Vault stores purchased and earned drops and migrates legacy drop balances", () => {
  assert.match(app, /function normalizeVaultItems\(savedItems\)/);
  assert.match(app, /function addVaultItem\(nextAccount, type, quantity = 1, details = \{\}\)/);
  assert.match(app, /legacyMissionDrops/);
  assert.match(app, /legacyPassDrops/);
  assert.match(app, /addWeeklyVaultDrops\(updated, rewards\.drops, weekNumber\)/);
  assert.match(app, /function openVaultItem\(itemId, requestedQuantity = 1\)/);
  assert.match(app, /promptVaultAcquisition\(item, quantity\)/);
  assert.match(html, /id="screen-vault"/);
  assert.match(html, /id="vault-acquire-dialog"/);
  assert.match(html, /id="vault-results-dialog"/);
});

test("Vault entries stack by item and weekly rarity while rejecting invalid quantities", () => {
  const helperSource = app.slice(
    app.indexOf("const VAULT_ITEM_TYPES ="),
    app.indexOf("function normalizeAccount(")
  );
  let nextId = 0;
  const context = {
    randomHex: () => `vault-${++nextId}`,
    t: (key) => key,
    account: { vaultItems: [] }
  };
  runInNewContext(`${helperSource}\nglobalThis.vaultHelpers = { addVaultItem, normalizeVaultItems };`, context);
  const { addVaultItem, normalizeVaultItems } = context.vaultHelpers;
  let result = addVaultItem({ vaultItems: [] }, "mission-drop", 2);
  result = addVaultItem(result.account, "mission-drop", 3);
  assert.equal(result.account.vaultItems.length, 1);
  assert.equal(result.account.vaultItems[0].quantity, 5);

  result = addVaultItem(result.account, "weekly-drop", 15, { weekNumber: 1, rarity: "rare" });
  result = addVaultItem(result.account, "weekly-drop", 3, { weekNumber: 1, rarity: "epic" });
  assert.equal(result.account.vaultItems.length, 3);
  assert.equal(result.account.vaultItems[1].quantity, 15);
  assert.equal(result.account.vaultItems[2].rarity, "epic");

  const normalized = normalizeVaultItems([
    ...result.account.vaultItems,
    { ...result.account.vaultItems[0] },
    { id: "invalid", type: "mission-drop", quantity: -1, acquiredAt: Date.now() }
  ]);
  assert.equal(normalized.length, 3);
});

test("the December events and Neon Pass are scheduled for the requested dates", () => {
  const frostRace = events.events.find((event) => event.id === "corrida-tokens-geada-2026");
  const christmas = events.events.find((event) => event.id === "natal-2026");
  assert.equal(Date.parse(frostRace.startsAt), Date.parse("2026-12-01T00:00:00-03:00"));
  assert.equal(Date.parse(frostRace.endsAt), Date.parse("2027-01-01T00:00:00-03:00"));
  assert.equal(frostRace.gameMode, "frost-tokens");
  assert.equal(frostRace.shop.skinOffers.length, 3);
  assert.ok(frostRace.shop.skinOffers.every((offer) => offer.priceTokens === 350));
  assert.deepEqual(frostRace.shop.coinPacks.map(({ amount, priceTokens }) => [amount, priceTokens]), [
    [1000, 20], [2000, 40], [3000, 60]
  ]);
  assert.deepEqual(frostRace.shop.tokenBoost, {
    multiplier: 3,
    priceTokens: 15,
    durationMs: 86400000
  });
  assert.equal(Date.parse(christmas.startsAt), Date.parse("2026-12-01T00:00:00-03:00"));
  assert.equal(Date.parse(christmas.endsAt), Date.parse("2026-12-25T23:59:59-03:00"));
  assert.equal(christmas.phases.length, 4);
  assert.equal(Date.parse(battlePass.visibleFrom), Date.parse("2026-11-30T00:00:00-03:00"));
  assert.ok(Date.parse(battlePass.visibleFrom) <= Date.parse("2026-12-01T00:00:00-03:00"));
  for (const [category, skinId] of [
    ["ship", "ship-frost-race"], ["shield", "shield-frost-race"], ["shot", "shot-frost-race"]
  ]) {
    const skin = skins.categories[category].find((entry) => entry.id === skinId);
    assert.ok(skin);
    assert.ok(skin.opacity < 1);
  }
});

test("Frost Token Rush isolates its currency and one-day multiplier from the Neon Pass", () => {
  assert.match(app, /function collectFrostEventToken\(\)/);
  assert.match(app, /const amount = frostTokenRace\.boostExpiresAt > now \? 3 : 1/);
  assert.match(app, /boostExpiresAt: Math\.max\(Date\.now\(\), tokenRace\.boostExpiresAt\) \+ boost\.durationMs/);
  assert.match(app, /type: frostTokenEvent \? "frost-token" : "pass-token"/);
  assert.match(app, /function isPlayableEvent\(event\)/);
  assert.match(app, /function purchaseFrostShopItem\(kind, value\)/);
  assert.match(app, /function eventScoreLimit\(event\)/);
  assert.match(html, /data-event-tab="shop"/);
  assert.match(html, /id="frost-shop-list"/);
});

test("ADM redemption falls back when the master panel is not configured", () => {
  assert.match(app, /response\.status !== 401 && response\.status !== 503/);
  assert.match(app, /cloudRequest\("\/api\/adm\/activate"/);
  assert.match(app, /admRequiresCloud/);
});

test("new account registration uses Firebase without a misleading local-only greeting", () => {
  assert.match(app, /cloudRequest\("\/api\/auth\/register"/);
  assert.match(app, /inboxWelcomeBody: "Sua conta está pronta/);
  assert.doesNotMatch(app, /inboxWelcomeBody: "Sua conta local está pronta/);
  assert.doesNotMatch(app, /inboxWelcomeBody: "Your local account is ready/);
});

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

test("master access stays server-side and old admin settings links are removed", () => {
  assert.match(app, /\/api\/master\/verify-code/);
  assert.match(html, /id="game-site-frame"/);
  assert.doesNotMatch(html, /id="open-admin-request-site"/);
  assert.doesNotMatch(html, /id="open-master-panel"/);
  assert.match(masterSite, /id="master-password"/);
  assert.match(adminRequestSite, /id="request-form"/);
  assert.match(adminRequestScript, /api\/admin\/requests/);
  assert.match(worker, /url\.pathname === "\/api\/admin\/requests" \|\| url\.pathname === "\/api\/adm\/requests"/);
  assert.match(wrangler, /127\.0\.0\.1:8765/);
  assert.match(wrangler, /localhost:5500/);
  assert.match(html, /settings-version[\s\S]*1\.0\.15/);
  assert.match(app, /openGameSite\("SITES\/master\.html"\)/);
  assert.match(masterSite, /ACCOUNT_SPECIAL_CODE/);
  assert.match(masterSite, /MASTER_PASSWORD/);
  assert.match(masterSite, /Senha mestre/);
  assert.match(html, /id="adm-quick-button"/);
  assert.match(html, /id="screen-adm"/);
  assert.match(app, /\/api\/adm\/activate/);
  assert.match(worker, /url\.pathname === "\/api\/adm\/activate"/);
  assert.match(worker, /ADM_ACTIVATION_CODE/);
  assert.match(html, /id="username-change-form"/);
  assert.match(worker, /30 \* 24 \* 60 \* 60 \* 1000/);
});

test("the new admin role is separate from the legacy admin panel and has bounded gifts", () => {
  assert.match(worker, /admEnabled: profile\.admEnabled === true/);
  assert.match(worker, /O limite de 10 Passes do modo ADM foi atingido/);
  assert.match(worker, /body\.type === "coins" \? 10_000 : 1_000/);
  assert.match(worker, /state\.coins = ADM_BALANCE/);
  assert.match(worker, /state\.diamonds = ADM_BALANCE/);
  assert.match(app, /admEnabled: profile\.admEnabled === true/);
  assert.match(app, /account\.admEnabled \? \(type === "diamonds" \? 1_000 : 10_000\)/);
  assert.match(app, /admPassGiftCount >= 10/);
  assert.match(worker, /async function masterLogin/);
  assert.match(worker, /ACCOUNT_SPECIAL_CODE/);
  assert.match(worker, /adminApprovedAt \+ 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(worker, /recipients\.size > 5/);
  assert.match(worker, /now - 24 \* 60 \* 60 \* 1000/);
  assert.match(app, /LOCAL_MIGRATION_GRACE_MS = 3 \* 24 \* 60 \* 60 \* 1000/);
});

test("admins receive game entitlements and both admin panels can send skins", () => {
  assert.match(app, /if \(normalized\.adminMode\) \{/);
  assert.match(app, /normalized\.coins = ADM_BALANCE/);
  assert.match(app, /normalized\.diamonds = ADM_BALANCE/);
  assert.match(app, /normalized\.ownedSkins = \[\.\.\.new Set/);
  assert.match(app, /normalized\.badges = \{/);
  assert.match(html, /<option value="skin" data-i18n="skinGift">/);
  assert.match(masterSite, /id="master-gift-skin"/);
  assert.match(worker, /type === "skin"/);
  assert.match(worker, /fallbackCoins: 100/);
});
