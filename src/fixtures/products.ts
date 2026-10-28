/** Fictional test data. These URLs are never requested. No real supplier values. */
export const mockProducts: Record<string, unknown>[] = [
    {
        url: 'https://example.invalid/products/MOCK-1688-001',
        title: 'Producto ficticio TU CUMPA',
        price: { amount: 12.5, currency: 'CNY' },
        moq: 10,
        weight: { value: 0.4, unit: 'kg' },
        dimensions: { length: 20, width: 10, height: 5, unit: 'cm' },
        images: ['https://example.invalid/images/mock-product.jpg'],
        characteristics: [{ name: 'Material', value: 'Material simulado' }],
        variations: [
            {
                productId: 'MOCK-1688-001-A',
                title: 'Variante simulada A',
                price: { amount: 13, currency: 'CNY' },
                images: ['https://example.invalid/images/mock-variant.jpg'],
                characteristics: [{ name: 'Color', value: 'Azul simulado' }],
            },
        ],
        productId: 'MOCK-1688-001',
    },
    { title: 'Producto ficticio incompleto', productId: 'MOCK-INCOMPLETE-002' },
    {
        title: '',
        url: 'ftp://example.invalid/unsupported',
        price: { amount: 'no disponible' },
        moq: -1,
        weight: { value: 'desconocido' },
        dimensions: { length: -5 },
        images: ['https://example.invalid/images/known.jpg', false],
        characteristics: [{ name: 'Material' }, null],
        variations: [{ title: 'Variante sin precio' }],
        productId: 'MOCK-INVALID-003',
    },
];
