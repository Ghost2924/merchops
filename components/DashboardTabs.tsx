'use client';

import { useState, ReactNode } from 'react';
import { BarChart2, ShoppingCart, Layers } from 'lucide-react';

interface DashboardTabsProps {
  salesTab: ReactNode;
  ordersTab: ReactNode;
  inventoryTab: ReactNode;
}

type TabType = 'sales' | 'orders' | 'inventory';

export default function DashboardTabs({ salesTab, ordersTab, inventoryTab }: DashboardTabsProps) {
  const [activeTab, setActiveTab] = useState<TabType>('sales');

  const tabs = [
    { id: 'sales', label: 'Sales & Trends', icon: <BarChart2 size={16} /> },
    { id: 'orders', label: 'Orders & Search', icon: <ShoppingCart size={16} /> },
    { id: 'inventory', label: 'Inventory Intel', icon: <Layers size={16} /> },
  ] as const;

  return (
    <div className="space-y-6">
      {/* Tab Switcher */}
      <div className="flex justify-center sm:justify-start">
        <div className="flex p-1 bg-white/70 dark:bg-surface-card/75 backdrop-blur-md border border-gray-100 dark:border-surface-border rounded-full shadow-sm">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={[
                  'flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold transition-all duration-300',
                  isActive
                    ? 'bg-accent-primary text-white shadow-sm scale-105'
                    : 'text-gray-500 dark:text-text-secondary hover:text-gray-900 dark:hover:text-text-primary hover:bg-gray-100/50 dark:hover:bg-surface-hover/50',
                ].join(' ')}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div className="transition-all duration-350 ease-out">
        {activeTab === 'sales' && <div className="space-y-6 animate-fadeIn">{salesTab}</div>}
        {activeTab === 'orders' && <div className="space-y-6 animate-fadeIn">{ordersTab}</div>}
        {activeTab === 'inventory' && <div className="space-y-6 animate-fadeIn">{inventoryTab}</div>}
      </div>
    </div>
  );
}
