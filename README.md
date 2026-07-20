# Prince Picker

**Offline-First Warehouse Picking Platform**

Prince Picker is an enterprise-grade warehouse inventory and picking platform designed for speed, reliability, and offline availability. It runs in the browser, installs as a Progressive Web App (PWA), and allows your warehouse operators to pick orders up to 3× faster.

## Features

- **Offline-First**: Fully functional in network dead zones. Automatically syncs when the connection is restored.
- **Fast Barcode Scanning**: Instant camera-based barcode scanning built natively into the web app.
- **Real-Time Analytics**: Built-in dashboards to track picker cycle times and accuracy.
- **Zero Latency**: Powered by IndexedDB and standard web technologies for blazing-fast performance.

## Architecture & Folder Structure

```
/
│── index.html                 ← Premium Marketing Website
│── app/
│      index.html              ← Prince Picker Web Application (PWA)
│      manifest.json           ← PWA Configuration
│      sw.js                   ← Service Worker for Offline Mode
│── robots.txt                 ← SEO Crawler rules
│── sitemap.xml                ← SEO Sitemap
│── llms.txt                   ← AI Search Optimization mapping
│── README.md
```

## Setup & Deployment

1. **Local Development**
   Simply serve the folder using any HTTP server:
   ```bash
   npx http-server . -p 3000
   ```
   *Note: For the Service Worker and camera features to work on external devices, the app must be served over HTTPS or `localhost`.*

2. **Production Deployment (GitHub Pages, Vercel, Netlify)**
   Since Prince Picker is entirely client-side, it can be deployed to any static host.
   - Simply push the repository to GitHub.
   - Connect the repository to Vercel or Netlify.
   - The app will automatically build and deploy.

## Roadmap
- [ ] Push Notifications for assigned orders
- [ ] Bluetooth Scanner API Integration
- [ ] Real-time Socket.io bridge

## Contributing
We welcome contributions! Please follow standard fork-and-pull-request workflows. Ensure any new UI additions adhere to the minimal, industrial design language of the platform.

## License
MIT License. See `LICENSE` for details.
