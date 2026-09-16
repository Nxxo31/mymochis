(function () {
  const defaults = {
    version: 2,
    store: {
      slug: 'mymochis',
      name: "Mochi's Land",
      handle: 'my.mochiss',
      tagline: 'Una nueva experiencia',
      description: 'Mochis artesanales hechos a mano en Neiva. Pedidos por WhatsApp y recogida coordinada con la tienda.',
      location: 'Neiva - Huila',
      schedule: 'Mar–Sáb · 3pm a 7pm',
      category: 'Tienda de repostería',
      whatsapp: '',
      whatsappLink: 'https://wa.me/message/BVXB2J33ADRQF1',
      instagram: '@my.mochiss',
      instagramUrl: 'https://instagram.com/my.mochiss',
      facebook: '',
      facebookUrl: '',
      tiktok: '',
      tiktokUrl: '',
      currency: 'COP',
      logo: 'logo-mochis-land.svg',
      theme: {
        primary: '#ef7fb3',
        primaryDeep: '#d95795',
        accent: '#70d7ef',
        sun: '#ffd64d',
        ink: '#20304a',
        soft: '#fff6df',
        paper: '#ffffff',
        mint: '#7fc9a9'
      }
    },
    tracking: {
      metaPixelId: ''
    },
    flavors: [
      {
        id: 'fresas-crema',
        name: 'Fresas con crema',
        description: 'Fresa fresca del Huila, crema batida y un toque de vainilla.',
        price: 8000,
        color: '#ff9fbe',
        accent: '#d94f78',
        available: true,
        image: ''
      },
      {
        id: 'chokis-cream',
        name: 'Chokis & cream',
        description: 'Trozos de galleta Chokis con crema dulce.',
        price: 8000,
        color: '#ffd98f',
        accent: '#a86f35',
        available: true,
        image: ''
      },
      {
        id: 'blueberry',
        name: 'Blueberry',
        description: 'Arándano entero, crema suave y un guiño de limón.',
        price: 8000,
        color: '#89a7e8',
        accent: '#42599e',
        available: true,
        image: ''
      },
      {
        id: 'durazno-caramelizado',
        name: 'Durazno caramelizado',
        description: 'Rodaja de durazno con caramelo dorado y notas de canela.',
        price: 8000,
        color: '#ffbd75',
        accent: '#b86925',
        available: true,
        image: ''
      },
      {
        id: 'crema-pastelera',
        name: 'Crema pastelera',
        description: 'La clásica: vainilla, yema y un corazón cremoso.',
        price: 8000,
        color: '#fae7b8',
        accent: '#b3934d',
        available: true,
        image: ''
      }
    ],
    promos: [
      {
        id: 'combo-4',
        title: 'Combo 4',
        subtitle: '4 unidades',
        description: 'Ideal para probar varios sabores en una tarde. El cliente elige la combinación.',
        units: 4,
        price: 28000,
        compareAt: 32000,
        flavorIds: ['fresas-crema', 'chokis-cream', 'blueberry', 'durazno-caramelizado', 'crema-pastelera'],
        featured: false,
        active: true,
        image: ''
      },
      {
        id: 'combo-6',
        title: 'Combo 6',
        subtitle: '6 unidades',
        description: 'El favorito para compartir en familia o con amigos. Sabores ajustables.',
        units: 6,
        price: 39000,
        compareAt: 48000,
        flavorIds: ['fresas-crema', 'chokis-cream', 'blueberry', 'durazno-caramelizado', 'crema-pastelera'],
        featured: true,
        active: true,
        image: ''
      },
      {
        id: 'caja-12',
        title: 'Caja sorpresa 12',
        subtitle: '12 unidades',
        description: 'Caja surtida con todos los sabores y pruebas nuevas de la semana.',
        units: 12,
        price: 75000,
        compareAt: 96000,
        flavorIds: ['fresas-crema', 'chokis-cream', 'blueberry', 'durazno-caramelizado', 'crema-pastelera'],
        featured: false,
        active: true,
        image: ''
      }
    ],
    photos: []
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(prefix) {
    return (prefix || 'nx') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function slugify(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item';
  }

  function storageKey(slug) {
    return 'nxstore_' + (slug || defaults.store.slug) + '_config_v2';
  }

  function ordersKey(slug) {
    return 'nxstore_' + (slug || defaults.store.slug) + '_orders_v2';
  }

  function cartKey(slug) {
    return 'nxstore_' + (slug || defaults.store.slug) + '_cart_v2';
  }

  function attributionKey(slug) {
    return 'nxstore_' + (slug || defaults.store.slug) + '_attribution_v2';
  }

  function merge(base, saved) {
    const out = clone(base);
    if (!saved || typeof saved !== 'object') return out;
    if (saved.store && typeof saved.store === 'object') {
      Object.assign(out.store, saved.store);
      out.store.theme = Object.assign({}, base.store.theme || {}, saved.store.theme || {});
    }
    if (saved.tracking && typeof saved.tracking === 'object') {
      Object.assign(out.tracking, saved.tracking);
    }
    ['flavors', 'promos', 'photos'].forEach(key => {
      if (Array.isArray(saved[key])) out[key] = clone(saved[key]);
    });
    if (saved.version) out.version = saved.version;
    return out;
  }

  window.NX_STORE = {
    defaults: clone(defaults),
    clone,
    uid,
    slugify,
    storageKey,
    ordersKey,
    cartKey,
    attributionKey,
    merge
  };
})();
