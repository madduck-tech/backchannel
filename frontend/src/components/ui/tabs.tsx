"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

/**
 * Two tab voices, because the app has two jobs for them — see /design/backchannel/DESIGN.md
 * § Component rules on chrome selection.
 *
 * `segmented` (default) is the in-panel switch: a sunken track with the active
 * option raised onto --elevated. Same shape as the theme control in Settings.
 *
 * `underline` is the page-level view switcher: a hairline rule under the strip,
 * typography carrying the state. It deliberately draws **no** indicator — the
 * caller owns that, so the Settings page keeps its spring-tracked underline
 * instead of fighting a second one drawn here.
 */
type TabsVariant = "segmented" | "underline"

const TabsVariantContext = React.createContext<TabsVariant>("segmented")

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
    variant?: TabsVariant
  }
>(({ className, variant = "segmented", ...props }, ref) => (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        variant === "underline"
          ? "relative inline-flex w-full items-center justify-start border-b border-line"
          : "inline-flex h-9 items-center justify-center gap-0.5 rounded-md border border-line bg-sunken p-0.5",
        className
      )}
      {...props}
    />
  </TabsVariantContext.Provider>
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, onClick, ...props }, ref) => {
  const variant = React.useContext(TabsVariantContext)

  /**
   * Radix activates a tab on `mousedown`, `keydown` and `focus`, and handles no
   * `click` at all (`@radix-ui/react-tabs` composes exactly those three). Assistive
   * technology does not send any of them: an accessibility API's "click" action
   * dispatches a plain DOM `click`, which the primitive ignores. The tab strip is
   * therefore inert to a screen reader and to anything driving the app through
   * AT-SPI — the settings tabs cannot be switched at all.
   *
   * `detail` is 0 only for a click that no pointer produced, which is what an
   * assistive click looks like. A real mouse click already fired `mousedown` and
   * must not be given a second one, or the tab activates twice.
   */
  const activateWithoutAPointer = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event)
      if (event.defaultPrevented || event.detail !== 0) return
      event.currentTarget.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })
      )
    },
    [onClick]
  )

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      onClick={activateWithoutAPointer}
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium",
        "transition-colors duration-fast",
        "disabled:pointer-events-none disabled:opacity-45",
        variant === "underline"
          ? "relative z-10 px-3.5 py-3 text-base text-ink-muted hover:text-ink data-[state=active]:font-medium data-[state=active]:text-ink"
          : "rounded-sm px-2.5 py-1.5 text-ink-muted hover:text-ink data-[state=active]:bg-elevated data-[state=active]:text-ink data-[state=active]:shadow-pop",
        className
      )}
      {...props}
    />
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("mt-2", className)} {...props} />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
