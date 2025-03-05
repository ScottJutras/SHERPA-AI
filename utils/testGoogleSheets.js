const { getMaterialPrices } = require('../googleSheetsIntegration'); 

async function test() {
    const materials = [
        { name: 'Vinyl Siding', quantity: 10 },
        { name: 'Underlayment', quantity: 5 }
    ];

    console.log("🔹 Testing Default Spreadsheet:");
    const result1 = await getMaterialPrices(materials, 'default');
    console.log(result1);

    console.log("🔹 Testing Quoting Spreadsheet:");
    const result2 = await getMaterialPrices(materials, 'quotes');
    console.log(result2);
}

test();
