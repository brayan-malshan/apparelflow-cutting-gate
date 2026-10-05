const bcrypt = require('bcryptjs');

const DEMO_USERS = [
  { email: 'supervisor@apparelflow.demo', password: 'Cut#Super2026', role: 'cutting_supervisor', full_name: 'Nimali Perera' },
  { email: 'verifier@apparelflow.demo', password: 'Verify#QC2026', role: 'cutting_verifier', full_name: 'Kasun Fernando' },
  { email: 'sewing@apparelflow.demo', password: 'Sew#Floor2026', role: 'sewing_supervisor', full_name: 'Dilani Silva' },
];

const RECIPES = [
  {
    recipe_code: 'REC-BL01', name: 'Casual Blouse', category: 'Blouse', std_fabric_yards: 1.8, wastage_cap: 5.0,
    components: [
      ['Front Body Panel', 1], ['Back Body Panel', 1], ['Sleeves (Left & Right)', 2],
      ['Collar & Stand', 1], ['Sleeve Cuffs', 2],
    ],
  },
  {
    recipe_code: 'REC-CT02', name: 'Crop Top', category: 'Crop Top', std_fabric_yards: 1.1, wastage_cap: 8.0,
    components: [
      ['Front Chest Panel', 1], ['Back Support Panel', 1], ['Neck Binding Strip', 1],
      ['Hem Elastic Casing', 1], ['Side Strap Accents', 2],
    ],
  },
];

// Idempotent: safe to run on every boot.
function seed(db) {
  const insUser = db.prepare('INSERT OR IGNORE INTO users (email, password_hash, role, full_name) VALUES (?,?,?,?)');
  const insRecipe = db.prepare('INSERT OR IGNORE INTO recipes (recipe_code, name, category, std_fabric_yards, wastage_cap) VALUES (?,?,?,?,?)');
  const getRecipe = db.prepare('SELECT id FROM recipes WHERE recipe_code = ?');
  const countComps = db.prepare('SELECT COUNT(*) c FROM recipe_components WHERE recipe_id = ?');
  const insComp = db.prepare('INSERT INTO recipe_components (recipe_id, component_name, pieces_per_garment, image_url) VALUES (?,?,?,NULL)');

  db.transaction(() => {
    for (const u of DEMO_USERS) {
      const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email);
      if (!exists) insUser.run(u.email, bcrypt.hashSync(u.password, 10), u.role, u.full_name);
    }
    for (const r of RECIPES) {
      insRecipe.run(r.recipe_code, r.name, r.category, r.std_fabric_yards, r.wastage_cap);
      const { id } = getRecipe.get(r.recipe_code);
      if (countComps.get(id).c === 0) {
        for (const [name, pcs] of r.components) insComp.run(id, name, pcs);
      }
    }
  })();
}

module.exports = { seed, DEMO_USERS, RECIPES };
