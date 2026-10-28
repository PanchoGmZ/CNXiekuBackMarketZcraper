/** Synthetic Schema.org fixtures only. No marketplace HTML was captured or verified. */
export const cnxiekuHtml = `<!doctype html>
<!-- SYNTHETIC: authored locally; not captured from a marketplace; never request these URLs. -->
<html><head><meta charset="utf-8"><title>Fixture sintético</title>
<meta property="og:type" content="product">
<meta property="og:title" content="Título alternativo CNXieku">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "url": "https://www.cnxieku.com/product/MOCK-HTML-001",
  "name": "Calzado sintético CNXieku",
  "productID": "CNX-HTML-001",
  "image": [
    "https://example.invalid/cnx/front.jpg",
    "https://example.invalid/cnx/side.jpg"
  ],
  "offers": {
    "@type": "Offer",
    "price": "89.50",
    "priceCurrency": "CNY",
    "eligibleQuantity": {
      "@type": "QuantitativeValue",
      "minValue": 2
    }
  },
  "weight": {
    "@type": "QuantitativeValue",
    "value": "0.75",
    "unitText": "kg"
  },
  "width": {
    "@type": "QuantitativeValue",
    "value": 12,
    "unitText": "cm"
  },
  "height": {
    "@type": "QuantitativeValue",
    "value": 10,
    "unitText": "cm"
  },
  "depth": {
    "@type": "QuantitativeValue",
    "value": 30,
    "unitText": "cm"
  },
  "additionalProperty": [
    {
      "@type": "PropertyValue",
      "name": "Material",
      "value": "Material ficticio"
    }
  ],
  "hasVariant": [
    {
      "@type": "Product",
      "name": "Talla de prueba 40",
      "sku": "CNX-40",
      "offers": {
        "@type": "Offer",
        "price": "89.50",
        "priceCurrency": "CNY"
      },
      "image": "https://example.invalid/cnx/40.jpg",
      "additionalProperty": [
        {
          "@type": "PropertyValue",
          "name": "Talla",
          "value": "40"
        }
      ]
    }
  ]
}
</script></head><body><a href="/catalogue">Enlace que no debe recorrerse</a></body></html>`;
export const backMarketHtml = `<!doctype html>
<!-- SYNTHETIC: authored locally; not captured from a marketplace; never request these URLs. -->
<html><head><meta charset="utf-8"><title>Fixture sintético</title>
<meta property="og:type" content="product">
<meta property="og:title" content="Título alternativo Back Market">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Product",
      "url": "https://www.backmarket.es/product/unrelated",
      "name": "Recomendación que debe ignorarse",
      "offers": {
        "@type": "Offer",
        "price": 1,
        "priceCurrency": "EUR"
      }
    },
    {
      "@type": "ProductGroup",
      "@id": "https://www.backmarket.es/product/MOCK-HTML-002#product",
      "url": "https://www.backmarket.es/product/MOCK-HTML-002",
      "name": "Teléfono sintético Back Market",
      "productID": "BM-HTML-002",
      "image": {
        "@type": "ImageObject",
        "contentUrl": "https://example.invalid/bm/front.jpg"
      },
      "offers": {
        "@type": "Offer",
        "price": "299.90",
        "priceCurrency": "EUR"
      },
      "weight": {
        "@type": "QuantitativeValue",
        "value": 188,
        "unitCode": "GRM"
      },
      "width": {
        "@type": "QuantitativeValue",
        "value": "71.5",
        "unitText": "mm"
      },
      "height": {
        "@type": "QuantitativeValue",
        "value": "146.7",
        "unitText": "mm"
      },
      "additionalProperty": [
        {
          "@type": "PropertyValue",
          "name": "Capacidad",
          "value": "128 GB"
        }
      ],
      "hasVariant": [
        {
          "@type": "Product",
          "sku": "BM-BLUE",
          "name": "Azul sintético",
          "offers": {
            "@type": "Offer",
            "price": 309.9
          },
          "image": "https://example.invalid/bm/blue.jpg",
          "additionalProperty": [
            {
              "@type": "PropertyValue",
              "name": "Color",
              "value": "Azul"
            }
          ]
        }
      ]
    }
  ]
}
</script></head><body><a href="/catalogue">Enlace que no debe recorrerse</a></body></html>`;
export const metadataHtml = `<!doctype html><html><head>
<meta property="og:type" content="product">
<meta property="og:title" content="Producto solo metadatos">
<meta property="og:image" content="/image.jpg">
<script type="application/json">{"price":"999.99","currency":"USD"}</script>
</head><body></body></html>`;
