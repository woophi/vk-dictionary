import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Dictionary } from 'src/db/tables/Dictionary';
import { Connection, Repository } from 'typeorm';
import * as puppeteer from 'puppeteer';
import * as stripHtml from 'string-strip-html';
import { errMap } from 'src/utils/errors';

type Shape = {
  name: string;
  defenition: string;
  plainDefenition: string;
};

type SearchResult = {
  id: string;
  definition: string;
};

@Injectable()
export class ExpDictionaryService {
  private readonly logger = new Logger(ExpDictionaryService.name);

  constructor(
    @InjectRepository(Dictionary)
    private tableDict: Repository<Dictionary>,
    private connection: Connection,
  ) {}

  async fullTextSearch(query: string) {
    const r = (await this.tableDict.query(`
      select
        id,
        definition
      from
        (
        select
          id,
          name,
          definition,
          (
            setweight(to_tsvector(ts_config_name, name), 'A') || 
            setweight(to_tsvector(ts_config_name, definition_plain_text), 'B')
          ) as document
        from
          dictionary ) ps
      where
        ps.document @@ to_tsquery('${query}:*');
    `)) as SearchResult[];

    if (!r?.length) {
      const parsed = await this.parsePage(query);

      if (parsed.srs?.length) {
        const results = await this.saveNewToDictionary(parsed.srs);
        return results?.slice(0, 4) ?? [];
      }
    }

    return r?.slice(0, 4) ?? [];
  }

  async parsePage(query: string) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.goto(
      `https://povto.ru/russkie/slovari/tolkovie/ozhegova/search_ozhegov.php?q_tolk_ozh=${encodeURIComponent(
        query,
      )}`,
    );

    let data = await page.evaluate((q) => {
      const content2 = document.querySelector('.w3-container');
      const children = content2?.children ?? [];

      const srs = [];
      for (let child of children) {
        let src = child?.id?.includes(q) ? child : null;

        if (src) {
          srs.push(src.innerHTML);
        }
      }

      return {
        srs,
      };
    }, query);
    await browser.close();
    return data;
  }

  async saveNewToDictionary(srcs: string[]) {
    const queryRunner = this.connection.createQueryRunner();
    const results: SearchResult[] = [];

    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const shapes = this.shapeScrapedValues(srcs);

      for (const shape of shapes) {
        const newDictValue = new Dictionary(
          shape.name,
          shape.defenition,
          shape.plainDefenition,
        );
        await queryRunner.manager.save(newDictValue);
        results.push({
          id: newDictValue.id,
          definition: newDictValue.definition,
        });
      }

      await queryRunner.commitTransaction();
      return results;
    } catch (err) {
      this.logger.error(errMap(err));
      await queryRunner.rollbackTransaction();
      throw new Error(err);
    } finally {
      await queryRunner.release();
    }
  }

  shapeScrapedValues(srcs: string[]) {
    const shapes: Shape[] = [];
    for (const src of srcs) {
      let shape: Shape = {
        defenition: '',
        name: '',
        plainDefenition: '',
      };

      const nameMatches = src.match(/<dfn>(.*?)<\/dfn>/g);

      if (nameMatches?.length) {
        const cleanName =
          stripHtml(nameMatches[0] ?? '')
            .result?.replace(/\s/g, '')
            .toLowerCase() ?? '';

        if (!cleanName) continue;

        shape.name = cleanName;
      }

      shape.defenition = src;
      shape.plainDefenition = stripHtml(src).result;
      shapes.push(shape);
    }
    return shapes;
  }
}