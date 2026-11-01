import { registerIconPack } from "../.framework/components/xicon.js";
const p = (d) => ({ tag: "path", attrs: { d } }),
  c = (cx, cy, r) => ({ tag: "circle", attrs: { cx, cy, r } }),
  r = (x, y, width, height) => ({
    tag: "rect",
    attrs: { x, y, width, height, rx: 2 },
  });
registerIconPack({
  id: "cuo",
  label: "CUO local interface icons",
  icons: {
    user: { nodes: [c(12, 8, 4), p("M4 22v-2a8 8 0 0 1 16 0v2")] },
    shield: {
      nodes: [p("M12 3 20 6v6c0 4.5-3.1 7.3-8 9-4.9-1.7-8-4.5-8-9V6Z")],
    },
    logo: {
      nodes: [
        {
          tag: "path",
          attrs: {
            d: "M12 1 23 6.5 12 12 1 6.5Z",
            fill: "#284c92",
            stroke: "none",
          },
        },
        {
          tag: "path",
          attrs: {
            d: "M1 6.5 12 12v12L1 18Z",
            fill: "#2b60f3",
            stroke: "none",
          },
        },
        {
          tag: "path",
          attrs: {
            d: "M12 12 23 6.5V18l-11 6Z",
            fill: "#3277ff",
            stroke: "none",
          },
        },
      ],
    },
    calendar: {
      nodes: [
        r(3, 5, 18, 16),
        p("M3 10h18M8 3v5M16 3v5M7 14h3M14 14h3M7 18h3"),
      ],
    },
    clock: { nodes: [c(12, 12, 9), p("M12 7v5l4 2")] },
    history: { nodes: [p("M3 11a9 9 0 1 1 1 6M3 4v7h7M12 7v5l4 2")] },
    bell: {
      nodes: [p("M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4")],
    },
    users: {
      nodes: [
        c(9, 7, 3),
        p("M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3"),
      ],
    },
    link: {
      nodes: [
        p("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"),
        p("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"),
      ],
    },
    plus: { nodes: [p("M12 4v16M4 12h16")] },
    filter: { nodes: [p("M3 4h18l-7 8v7l-4 2v-9Z")] },
    more: { nodes: [c(5, 12, 1), c(12, 12, 1), c(19, 12, 1)] },
    ban: { nodes: [c(12, 12, 9), p("m5 19 14-14")] },
    cube: {
      nodes: [
        p("M12 2 22 7v10l-10 5L2 17V7Z M2 7l10 5 10-5M12 12v10M7 4.5l10 5"),
      ],
    },
    cloud: { nodes: [c(7, 13, 4), c(17, 13, 4), c(12, 11, 5)] },
    docker: {
      nodes: [
        r(3, 8, 4, 4),
        r(8, 8, 4, 4),
        r(13, 8, 4, 4),
        r(8, 3, 4, 4),
        p("M2 14h17l3-3c1 6-6 11-12 10-4 0-7-3-8-7Z"),
      ],
    },
  },
});
