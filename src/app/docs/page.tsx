// Swagger UI for the deployer API. Loaded from a public CDN so we don't
// have to bundle swagger-ui-react into the Next app. The spec itself is
// served by /api/v1/openapi.json — edit that file to change the docs.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Zynd Deployer API",
};

const SWAGGER_VERSION = "5.17.14";

export default function DocsPage() {
  const html = `
    <div id="swagger-ui"></div>
    <script>
      window.addEventListener("load", function () {
        window.ui = SwaggerUIBundle({
          url: "/api/v1/openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: "BaseLayout",
          tryItOutEnabled: true,
        });
      });
    </script>
  `;

  return (
    <div className="-mx-4 bg-white">
      <link
        rel="stylesheet"
        href={`https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css`}
      />
      <script
        src={`https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js`}
        async
      />
      <script
        src={`https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-standalone-preset.js`}
        async
      />
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
