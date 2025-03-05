const { getMaterialPrices } = require('./googleSheetsIntegration'); // Adjust path if needed

async function test() {
    const materials = [
        { name: 'Vinyl Siding', quantity: 10 },
        { name: 'Underlayment', quantity: 5 }
    ];

    const result = await getMaterialPrices(materials);
    console.log(result);
}

test();
