// Owns the glasses page: a one-line header and a body that captures input.
// Content never overflows a container, so the firmware never scrolls it and every
// swipe reaches us as an event.
import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { LINE_H, SCREEN_W } from "./text.ts";

export const HEADER = { id: 1, name: "header", x: 0, y: 0, w: SCREEN_W, h: 32, pad: 2 };
export const BODY = { id: 2, name: "body", x: 0, y: 34, w: SCREEN_W, h: 254, pad: 4 };
export const HEADER_INNER_W = HEADER.w - 2 * HEADER.pad;
export const BODY_INNER_W = BODY.w - 2 * BODY.pad - 4; // small safety margin against rounding
export const BODY_LINES = Math.floor((BODY.h - 2 * BODY.pad) / LINE_H);

export interface MenuItem {
  id: number;
  name: string;
}

export interface Frame {
  header: string;
  body: string[];
  menu?: MenuItem[];
}

export class Display {
  private created = false;
  private shown = { header: "", body: "", menuKey: "" };
  private pending: Frame | null = null;
  private busy = false;
  lastWriteAt = 0;
  onFrame: (f: Frame) => void = () => {};

  constructor(private bridge: EvenAppBridge) {}

  show(frame: Frame) {
    const body = frame.body.slice(0, BODY_LINES);
    this.pending = { ...frame, body };
    this.onFrame(this.pending);
    void this.flush();
  }

  private containers(header: string, body: string) {
    return [
      new TextContainerProperty({
        containerID: HEADER.id, containerName: HEADER.name,
        xPosition: HEADER.x, yPosition: HEADER.y, width: HEADER.w, height: HEADER.h,
        paddingLength: HEADER.pad, borderWidth: 0, isEventCapture: 0, content: header,
      }),
      new TextContainerProperty({
        containerID: BODY.id, containerName: BODY.name,
        xPosition: BODY.x, yPosition: BODY.y, width: BODY.w, height: BODY.h,
        paddingLength: BODY.pad, borderWidth: 0, isEventCapture: 1, content: body,
      }),
    ];
  }

  private menuObject(menu?: MenuItem[]) {
    if (!menu?.length) return undefined;
    return new MenuContainerProperty({ menuItems: menu.slice(0, 10).map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.name })) });
  }

  private async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending) {
        const frame = this.pending;
        this.pending = null;
        const header = frame.header || " ";
        const body = frame.body.join("\n") || " ";
        const menuKey = JSON.stringify(frame.menu || []);
        if (!this.created) {
          const result = await this.bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: this.containers(header, body), menuObject: this.menuObject(frame.menu) }),
          );
          // Treat startup as spent even when it fails; later frames rebuild instead.
          this.created = true;
          if (String(result) !== "0" && String(result) !== "success") {
            await this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 2, textObject: this.containers(header, body), menuObject: this.menuObject(frame.menu) }));
          }
          this.shown = { header, body, menuKey };
        } else if (menuKey !== this.shown.menuKey) {
          await this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 2, textObject: this.containers(header, body), menuObject: this.menuObject(frame.menu) }));
          this.shown = { header, body, menuKey };
        } else {
          if (header !== this.shown.header) {
            await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: HEADER.id, containerName: HEADER.name, content: header }));
            this.shown.header = header;
          }
          if (body !== this.shown.body) {
            await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: BODY.id, containerName: BODY.name, content: body }));
            this.shown.body = body;
          }
        }
        this.lastWriteAt = Date.now();
      }
    } catch (err) {
      console.error("display write failed", err);
    } finally {
      this.busy = false;
    }
  }
}
