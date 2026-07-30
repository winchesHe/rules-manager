import { Table } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import type { Project } from '../types'

export function ProjectsTable({ projects }: { projects: Project[] }) {
  const { t } = useTranslation('projects')
  return (
    <Table className="rounded-none bg-transparent shadow-none">
      <Table.ScrollContainer>
        <Table.Content aria-label={t('list.tableLabel')}>
          <Table.Header>
            <Table.Column isRowHeader>{t('columns.project')}</Table.Column>
            <Table.Column>{t('columns.agents')}</Table.Column>
            <Table.Column>{t('columns.sessions')}</Table.Column>
          </Table.Header>
          <Table.Body>
            {projects.map((project) => (
              <Table.Row id={project.slug} key={project.slug}>
                <Table.Cell>{project.slug}</Table.Cell>
                <Table.Cell className="text-muted">
                  {project.agents.join(' · ') || t('sharedTable.noAgents')}
                </Table.Cell>
                <Table.Cell className="text-muted">{project.sessionCount}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  )
}
