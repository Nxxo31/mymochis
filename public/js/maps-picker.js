(function () {
  'use strict';

  const LOADER_SRC = 'https://maps.googleapis.com/maps/api/js';
  const FALLBACK_CENTER = { lat: 2.9273, lng: -75.2896 };
  const FALLBACK_ZOOM = 12;
  const ZOOM = 14;

  let loaderPromise = null;

  function loadMapsLibrary(apiKey) {
    if (window.google && window.google.maps && typeof window.google.maps.importLibrary === 'function') {
      return Promise.resolve(window.google.maps);
    }
    if (!apiKey) return Promise.reject(new Error('missing_api_key'));
    if (loaderPromise) return loaderPromise;
    loaderPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${LOADER_SRC}?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async`;
      script.async = true;
      script.onload = () => {
        if (window.google && window.google.maps) {
          resolve(window.google.maps);
        } else {
          loaderPromise = null;
          reject(new Error('maps_unavailable'));
        }
      };
      script.onerror = () => {
        loaderPromise = null;
        reject(new Error('maps_load_failed'));
      };
      document.head.appendChild(script);
    });
    return loaderPromise;
  }

  function normalizeMapId(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length < 8) return '';
    return /^[A-Za-z0-9_-]+$/.test(text) ? text : '';
  }

  function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  class MapsPicker {
    constructor(options = {}) {
      this.container = options.container || null;
      this.latInput = options.latInput || null;
      this.lngInput = options.lngInput || null;
      this.addressInput = options.addressInput || null;
      this.placeIdInput = options.placeIdInput || null;
      this.statusEl = options.status || null;
      this.apiKey = options.apiKey || '';
      this.mapId = options.mapId || '';
      this.autoAddress = options.autoAddress !== false;
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
      this.map = null;
      this.marker = null;
      this.markerMode = null;
      this.geocoder = null;
      this.busy = false;
    }

    setStatus(kind, text) {
      if (!this.statusEl) return;
      this.statusEl.textContent = text;
      this.statusEl.className = 'maps-status' + (kind ? ` maps-status--${kind}` : '');
    }

    readPoint() {
      const latRaw = String(this.latInput ? this.latInput.value : '').trim();
      const lngRaw = String(this.lngInput ? this.lngInput.value : '').trim();
      if (!latRaw && !lngRaw) return null;
      const lat = toNumber(latRaw);
      const lng = toNumber(lngRaw);
      if (lat === null || lng === null) return null;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
      return { lat, lng };
    }

    writePoint(point) {
      if (this.latInput) this.latInput.value = Number(point.lat).toFixed(6);
      if (this.lngInput) this.lngInput.value = Number(point.lng).toFixed(6);
    }

    applyToMarker(point) {
      if (!this.marker) return;
      try {
        if (this.markerMode === 'advanced') {
          this.marker.position = { lat: point.lat, lng: point.lng };
        } else {
          this.marker.setPosition({ lat: point.lat, lng: point.lng });
        }
      } catch {}
    }

    centerOn(point) {
      if (!this.map) return;
      try {
        if (typeof this.map.panTo === 'function') this.map.panTo({ lat: point.lat, lng: point.lng });
        else if (typeof this.map.setCenter === 'function') this.map.setCenter({ lat: point.lat, lng: point.lng });
      } catch {}
    }

    handleMove(point) {
      this.applyToMarker(point);
      this.writePoint(point);
      this.onChange(point);
      if (this.autoAddress) this.reverseGeocode(point);
    }

    async reverseGeocode(point) {
      if (!this.geocoder) {
        this.setStatus('ok', 'Punto actualizado. Escribí la dirección a mano si la querés.');
        return;
      }
      this.setStatus('loading', 'Buscando la dirección de ese punto…');
      try {
        const results = await this.geocoder.geocode({ location: { lat: point.lat, lng: point.lng } });
        const hit = Array.isArray(results) ? results[0] : null;
        if (!hit) {
          this.setStatus('warn', 'Punto actualizado, pero no encontramos su dirección. Escríbela a mano.');
          return;
        }
        if (this.addressInput && hit.formatted_address) this.addressInput.value = hit.formatted_address;
        if (this.placeIdInput && hit.place_id) this.placeIdInput.value = hit.place_id;
        this.setStatus('ok', 'Punto y dirección actualizados. Revisa y guarda.');
      } catch {
        this.setStatus('warn', 'Punto actualizado, pero no pudimos leer la dirección. Escríbela a mano.');
      }
    }

    async start() {
      if (this.busy || this.map) return false;
      if (!this.container) return false;
      this.busy = true;
      this.setStatus('loading', 'Cargando el mapa…');
      try {
        const maps = await loadMapsLibrary(this.apiKey);
        const mapsLib = await maps.importLibrary('maps');
        let markerLib = null;
        try {
          markerLib = await maps.importLibrary('marker');
        } catch {}
        const MapCtor = mapsLib.Map || maps.Map;
        if (typeof MapCtor !== 'function') throw new Error('maps_unavailable');

        const current = this.readPoint();
        const mapOptions = {
          center: current || FALLBACK_CENTER,
          zoom: current ? ZOOM : FALLBACK_ZOOM,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        };
        const mapId = normalizeMapId(this.mapId);
        if (mapId) mapOptions.mapId = mapId;

        this.map = new MapCtor(this.container, mapOptions);

        const GeocoderCtor = mapsLib.Geocoder || maps.Geocoder;
        if (typeof GeocoderCtor === 'function') {
          try { this.geocoder = new GeocoderCtor(); } catch { this.geocoder = null; }
        }

        this.buildMarker(maps, mapsLib, markerLib, current || FALLBACK_CENTER);

        this.map.addListener('click', (event) => {
          const latLng = event && event.latLng;
          if (!latLng) return;
          const point = { lat: latLng.lat(), lng: latLng.lng() };
          this.handleMove(point);
        });

        this.busy = false;
        this.setStatus('ok', current
          ? 'Mapa listo. Arrastrá el pin o hacé clic en el mapa para moverlo.'
          : 'Mapa listo. Hacé clic en el mapa para poner el primer pin.');
        return true;
      } catch (err) {
        this.busy = false;
        this.map = null;
        this.marker = null;
        const code = err && err.message ? err.message : 'maps_load_failed';
        if (code === 'missing_api_key') {
          this.setStatus('error', 'No hay API key de Google Maps configurada. Escribí la latitud, la longitud y la dirección a mano.');
        } else if (code === 'maps_load_failed') {
          this.setStatus('error', 'No pudimos cargar Google Maps. Revisá tu conexión o usá los campos a mano.');
        } else {
          this.setStatus('error', 'Google Maps no está disponible ahora. Podés guardar la ubicación escribiéndola a mano.');
        }
        return false;
      }
    }

    buildMarker(maps, mapsLib, markerLib, position) {
      const Advanced = markerLib && markerLib.AdvancedMarkerElement;
      if (typeof Advanced === 'function' && normalizeMapId(this.mapId)) {
        try {
          const marker = new Advanced({
            map: this.map,
            position: { lat: position.lat, lng: position.lng },
            gmpDraggable: true,
            title: 'Centro de la zona de domicilio',
          });
          marker.addEventListener('gmp-dragend', () => {
            const pos = marker.position;
            if (!pos) return;
            this.handleMove({ lat: Number(pos.lat), lng: Number(pos.lng) });
          });
          this.marker = marker;
          this.markerMode = 'advanced';
          return;
        } catch {}
      }
      const Legacy = mapsLib.Marker || maps.Marker;
      if (typeof Legacy !== 'function') return;
      try {
        const marker = new Legacy({
          map: this.map,
          position: { lat: position.lat, lng: position.lng },
          draggable: true,
          title: 'Centro de la zona de domicilio',
        });
        marker.addListener('dragend', () => {
          const pos = marker.getPosition();
          if (!pos) return;
          this.handleMove({ lat: pos.lat(), lng: pos.lng() });
        });
        this.marker = marker;
        this.markerMode = 'legacy';
      } catch {}
    }

    syncFromInputs() {
      const point = this.readPoint();
      if (!point) return;
      this.applyToMarker(point);
      this.centerOn(point);
    }

    destroy() {
      if (this.marker) {
        try {
          if (this.markerMode === 'advanced') this.marker.map = null;
          else this.marker.setMap(null);
        } catch {}
      }
      this.marker = null;
      this.map = null;
      this.busy = false;
    }
  }

  window.MapsPicker = {
    load: loadMapsLibrary,
    create(options) { return new MapsPicker(options); },
  };
})();
